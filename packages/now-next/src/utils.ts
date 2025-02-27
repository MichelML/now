import zlib from 'zlib';
import path from 'path';
import fs from 'fs-extra';
import { ZipFile } from 'yazl';
import crc32 from 'buffer-crc32';
import { Sema } from 'async-sema';
import resolveFrom from 'resolve-from';
import {
  Files,
  FileFsRef,
  streamToBuffer,
  Lambda,
  Route,
} from '@now/build-utils';

type stringMap = { [key: string]: string };

export interface EnvConfig {
  [name: string]: string | undefined;
}

// Identify /[param]/ in route string
// eslint-disable-next-line no-useless-escape
const TEST_DYNAMIC_ROUTE = /\/\[[^\/]+?\](?=\/|$)/;

function isDynamicRoute(route: string): boolean {
  route = route.startsWith('/') ? route : `/${route}`;
  return TEST_DYNAMIC_ROUTE.test(route);
}

/**
 * Validate if the entrypoint is allowed to be used
 */
function validateEntrypoint(entrypoint: string) {
  if (
    !/package\.json$/.exec(entrypoint) &&
    !/next\.config\.js$/.exec(entrypoint)
  ) {
    throw new Error(
      'Specified "src" for "@now/next" has to be "package.json" or "next.config.js"'
    );
  }
}

/**
 * Exclude certain files from the files object
 */
function excludeFiles(
  files: Files,
  matcher: (filePath: string) => boolean
): Files {
  return Object.keys(files).reduce((newFiles, filePath) => {
    if (matcher(filePath)) {
      return newFiles;
    }
    return {
      ...newFiles,
      [filePath]: files[filePath],
    };
  }, {});
}

/**
 * Exclude package manager lockfiles from files
 */
function excludeLockFiles(files: Files): Files {
  const newFiles = files;
  if (newFiles['package-lock.json']) {
    delete newFiles['package-lock.json'];
  }
  if (newFiles['yarn.lock']) {
    delete newFiles['yarn.lock'];
  }
  return files;
}

/**
 * Enforce specific package.json configuration for smallest possible lambda
 */
function normalizePackageJson(
  defaultPackageJson: {
    dependencies?: stringMap;
    devDependencies?: stringMap;
    scripts?: stringMap;
  } = {}
) {
  const dependencies: stringMap = {};
  const devDependencies: stringMap = {
    ...defaultPackageJson.dependencies,
    ...defaultPackageJson.devDependencies,
  };

  if (devDependencies.react) {
    dependencies.react = devDependencies.react;
    delete devDependencies.react;
  }

  if (devDependencies['react-dom']) {
    dependencies['react-dom'] = devDependencies['react-dom'];
    delete devDependencies['react-dom'];
  }

  delete devDependencies['next-server'];

  return {
    ...defaultPackageJson,
    dependencies: {
      // react and react-dom can be overwritten
      react: 'latest',
      'react-dom': 'latest',
      ...dependencies, // override react if user provided it
      // next-server is forced to canary
      'next-server': 'v7.0.2-canary.49',
    },
    devDependencies: {
      ...devDependencies,
      // next is forced to canary
      next: 'v7.0.2-canary.49',
    },
    scripts: {
      ...defaultPackageJson.scripts,
      'now-build':
        'NODE_OPTIONS=--max_old_space_size=3000 next build --lambdas',
    },
  };
}

async function getNextConfig(workPath: string, entryPath: string) {
  const entryConfig = path.join(entryPath, './next.config.js');
  if (await fs.pathExists(entryConfig)) {
    return fs.readFile(entryConfig, 'utf8');
  }

  const workConfig = path.join(workPath, './next.config.js');
  if (await fs.pathExists(workConfig)) {
    return fs.readFile(workConfig, 'utf8');
  }

  return null;
}

function pathIsInside(firstPath: string, secondPath: string) {
  return !path.relative(firstPath, secondPath).startsWith('..');
}

function getPathsInside(entryDirectory: string, files: Files) {
  const watch: string[] = [];

  for (const file of Object.keys(files)) {
    // If the file is outside of the entrypoint directory, we do
    // not want to monitor it for changes.
    if (!pathIsInside(entryDirectory, file)) {
      continue;
    }

    watch.push(file);
  }

  return watch;
}

function normalizePage(page: string): string {
  // Resolve on anything that doesn't start with `/`
  if (!page.startsWith('/')) {
    page = `/${page}`;
  }
  // remove '/index' from the end
  page = page.replace(/\/index$/, '/');
  return page;
}

function getRoutes(
  entryPath: string,
  entryDirectory: string,
  pathsInside: string[],
  files: Files,
  url: string
): Route[] {
  let pagesDir = '';
  const filesInside: Files = {};
  const prefix = entryDirectory === `.` ? `/` : `/${entryDirectory}/`;
  const fileKeys = Object.keys(files);

  for (const file of fileKeys) {
    if (!pathsInside.includes(file)) {
      continue;
    }

    if (!pagesDir) {
      if (file.startsWith(path.join(entryDirectory, 'pages'))) {
        pagesDir = 'pages';
      }
    }

    filesInside[file] = files[file];
  }

  // If default pages dir isn't found check for `src/pages`
  if (
    !pagesDir &&
    fileKeys.some(file =>
      file.startsWith(path.join(entryDirectory, 'src/pages'))
    )
  ) {
    pagesDir = 'src/pages';
  }

  const routes: Route[] = [
    {
      src: `${prefix}_next/(.*)`,
      dest: `${url}/_next/$1`,
    },
    {
      src: `${prefix}static/(.*)`,
      dest: `${url}/static/$1`,
    },
  ];
  const filePaths = Object.keys(filesInside);
  const dynamicPages = [];

  for (const file of filePaths) {
    const relativePath = path.relative(entryDirectory, file);
    const isPage = pathIsInside(pagesDir, relativePath);

    if (!isPage) {
      continue;
    }

    const relativeToPages = path.relative(pagesDir, relativePath);
    const extension = path.extname(relativeToPages);
    const pageName = relativeToPages.replace(extension, '').replace(/\\/g, '/');

    if (pageName.startsWith('_')) {
      continue;
    }

    if (isDynamicRoute(pageName)) {
      dynamicPages.push(normalizePage(pageName));
      continue;
    }

    routes.push({
      src: `${prefix}${pageName}`,
      dest: `${url}/${pageName}`,
    });

    if (pageName.endsWith('index')) {
      const resolvedIndex = pageName.replace('/index', '').replace('index', '');

      routes.push({
        src: `${prefix}${resolvedIndex}`,
        dest: `${url}/${resolvedIndex}`,
      });
    }
  }

  routes.push(
    ...getDynamicRoutes(entryPath, entryDirectory, dynamicPages).map(
      (route: { src: string; dest: string }) => {
        // convert to make entire RegExp match as one group
        route.src = route.src
          .replace('^', `^${prefix}(`)
          .replace('(\\/', '(')
          .replace('$', ')$');
        route.dest = `${url}/$1`;
        return route;
      }
    )
  );

  // Add public folder routes
  for (const file of filePaths) {
    const relativePath = path.relative(entryDirectory, file);
    const isPublic = pathIsInside('public', relativePath);

    if (!isPublic) continue;

    const fileName = path.relative('public', relativePath);
    const route = {
      src: `${prefix}${fileName}`,
      dest: `${url}/${fileName}`,
    };

    // Only add the route if a page is not already using it
    if (!routes.some(r => r.src === route.src)) {
      routes.push(route);
    }
  }

  return routes;
}

export function getDynamicRoutes(
  entryPath: string,
  entryDirectory: string,
  dynamicPages: string[],
  isDev?: boolean
): { src: string; dest: string }[] {
  if (!dynamicPages.length) {
    return [];
  }

  let getRouteRegex:
    | ((pageName: string) => { re: RegExp })
    | undefined = undefined;

  let getSortedRoutes: ((normalizedPages: string[]) => string[]) | undefined;

  try {
    ({ getRouteRegex, getSortedRoutes } = require(resolveFrom(
      entryPath,
      'next-server/dist/lib/router/utils'
    )));
    if (typeof getRouteRegex !== 'function') {
      getRouteRegex = undefined;
    }
  } catch (_) {} // eslint-disable-line no-empty

  if (!getRouteRegex || !getSortedRoutes) {
    try {
      ({ getRouteRegex, getSortedRoutes } = require(resolveFrom(
        entryPath,
        'next/dist/next-server/lib/router/utils'
      )));
      if (typeof getRouteRegex !== 'function') {
        getRouteRegex = undefined;
      }
    } catch (_) {} // eslint-disable-line no-empty
  }

  if (!getRouteRegex || !getSortedRoutes) {
    throw new Error(
      'Found usage of dynamic routes but not on a new enough version of Next.js.'
    );
  }

  const pageMatchers = getSortedRoutes(dynamicPages).map(pageName => ({
    pageName,
    matcher: getRouteRegex && getRouteRegex(pageName).re,
  }));

  const routes: { src: string; dest: string }[] = [];
  pageMatchers.forEach(pageMatcher => {
    // in `now dev` we don't need to prefix the destination
    const dest = !isDev
      ? path.join('/', entryDirectory, pageMatcher.pageName)
      : pageMatcher.pageName;

    if (pageMatcher && pageMatcher.matcher) {
      routes.push({
        src: pageMatcher.matcher.source,
        dest,
      });
    }
  });
  return routes;
}

function syncEnvVars(base: EnvConfig, removeEnv: EnvConfig, addEnv: EnvConfig) {
  // Remove any env vars from `removeEnv`
  // that are not present in the `addEnv`
  const addKeys = new Set(Object.keys(addEnv));
  for (const name of Object.keys(removeEnv)) {
    if (!addKeys.has(name)) {
      delete base[name];
    }
  }

  // Add in the keys from `addEnv`
  Object.assign(base, addEnv);
}

export const ExperimentalTraceVersion = `9.0.4-canary.1`;

export type PseudoLayer = {
  [fileName: string]: {
    crc32: number;
    compBuffer: Buffer;
    uncompressedSize: number;
  };
};

const compressBuffer = (buf: Buffer): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    zlib.deflateRaw(
      buf,
      { level: zlib.constants.Z_BEST_COMPRESSION },
      (err, compBuf) => {
        if (err) return reject(err);
        resolve(compBuf);
      }
    );
  });
};

export async function createPseudoLayer(files: {
  [fileName: string]: FileFsRef;
}): Promise<PseudoLayer> {
  const pseudoLayer: PseudoLayer = {};

  for (const fileName of Object.keys(files)) {
    const file = files[fileName];
    const origBuffer = await streamToBuffer(file.toStream());
    const compBuffer = await compressBuffer(origBuffer);
    pseudoLayer[fileName] = {
      compBuffer,
      crc32: crc32.unsigned(origBuffer),
      uncompressedSize: origBuffer.byteLength,
    };
  }

  return pseudoLayer;
}

interface CreateLambdaFromPseudoLayersOptions {
  files: Files;
  layers: PseudoLayer[];
  handler: string;
  runtime: string;
  memory?: number;
  maxDuration?: number;
  environment?: { [name: string]: string };
}

// measured with 1, 2, 5, 10, and `os.cpus().length || 5`
// and sema(1) produced the best results
const createLambdaSema = new Sema(1);

export async function createLambdaFromPseudoLayers({
  files,
  layers,
  handler,
  runtime,
  memory,
  maxDuration,
  environment = {},
}: CreateLambdaFromPseudoLayersOptions) {
  await createLambdaSema.acquire();
  const zipFile = new ZipFile();
  const addedFiles = new Set();

  // apply pseudo layers (already compressed objects)
  for (const layer of layers) {
    for (const seedKey of Object.keys(layer)) {
      const { compBuffer, crc32, uncompressedSize } = layer[seedKey];

      // @ts-ignore: `addDeflatedBuffer` is a valid function, but missing on the type
      zipFile.addDeflatedBuffer(compBuffer, seedKey, {
        crc32,
        uncompressedSize,
      });

      addedFiles.add(seedKey);
    }
  }

  for (const fileName of Object.keys(files)) {
    // was already added in a pseudo layer
    if (addedFiles.has(fileName)) continue;
    const file = files[fileName];
    const fileBuffer = await streamToBuffer(file.toStream());
    zipFile.addBuffer(fileBuffer, fileName);
  }
  zipFile.end();

  const zipBuffer = await streamToBuffer(zipFile.outputStream);
  createLambdaSema.release();

  return new Lambda({
    handler,
    runtime,
    zipBuffer,
    memory,
    maxDuration,
    environment,
  });
}

export type NextPrerenderedRoutes = {
  routes: {
    [route: string]: {
      initialRevalidate: number | false;
      dataRoute: string;
      srcRoute: string | null;
    };
  };

  lazyRoutes: {
    [route: string]: {
      routeRegex: string;
      dataRoute: string;
      dataRouteRegex: string;
    };
  };
};

export async function getPrerenderManifest(
  entryPath: string
): Promise<NextPrerenderedRoutes> {
  const pathPrerenderManifest = path.join(
    entryPath,
    '.next',
    'prerender-manifest.json'
  );

  const hasManifest: boolean = await fs
    .access(pathPrerenderManifest, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);

  if (!hasManifest) {
    return { routes: {}, lazyRoutes: {} };
  }

  const manifest: {
    version: 1;
    routes: {
      [key: string]: {
        initialRevalidateSeconds: number | false;
        dataRoute: string;
        srcRoute: string | null;
      };
    };
    dynamicRoutes: {
      [key: string]: {
        routeRegex: string;
        dataRoute: string;
        dataRouteRegex: string;
      };
    };
  } = JSON.parse(await fs.readFile(pathPrerenderManifest, 'utf8'));

  switch (manifest.version) {
    case 1: {
      const routes = Object.keys(manifest.routes);
      const lazyRoutes = Object.keys(manifest.dynamicRoutes);

      const ret: NextPrerenderedRoutes = { routes: {}, lazyRoutes: {} };

      routes.forEach(route => {
        const {
          initialRevalidateSeconds,
          dataRoute,
          srcRoute,
        } = manifest.routes[route];
        ret.routes[route] = {
          initialRevalidate:
            initialRevalidateSeconds === false
              ? false
              : Math.max(1, initialRevalidateSeconds),
          dataRoute,
          srcRoute,
        };
      });

      lazyRoutes.forEach(lazyRoute => {
        const {
          routeRegex,
          dataRoute,
          dataRouteRegex,
        } = manifest.dynamicRoutes[lazyRoute];

        ret.lazyRoutes[lazyRoute] = { routeRegex, dataRoute, dataRouteRegex };
      });

      return ret;
    }
    default: {
      return { routes: {}, lazyRoutes: {} };
    }
  }
}

// We only need this once per build
let _usesSrcCache: boolean | undefined;

async function usesSrcDirectory(workPath: string): Promise<boolean> {
  if (!_usesSrcCache) {
    const source = path.join(workPath, 'src', 'pages');

    try {
      if ((await fs.stat(source)).isDirectory()) {
        _usesSrcCache = true;
      }
    } catch (_err) {
      _usesSrcCache = false;
    }
  }

  return Boolean(_usesSrcCache);
}

async function getSourceFilePathFromPage({
  workPath,
  page,
}: {
  workPath: string;
  page: string;
}) {
  if (await usesSrcDirectory(workPath)) {
    return path.join('src', 'pages', page);
  }

  return path.join('pages', page);
}

export {
  excludeFiles,
  validateEntrypoint,
  excludeLockFiles,
  normalizePackageJson,
  getNextConfig,
  getPathsInside,
  getRoutes,
  stringMap,
  syncEnvVars,
  normalizePage,
  isDynamicRoute,
  getSourceFilePathFromPage,
};
