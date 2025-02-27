import { DeploymentFile } from './hashes';
import { parse as parseUrl } from 'url';
import fetch_ from 'node-fetch';
import { join, sep } from 'path';
import qs from 'querystring';
import ignore from 'ignore';
import pkg from '../../package.json';
import { Options } from '../deploy';
import { NowJsonOptions } from '../types';
import { Sema } from 'async-sema';
import { readFile } from 'fs-extra';
const semaphore = new Sema(10);

export const API_FILES = '/v2/now/files';
export const API_DEPLOYMENTS = '/v10/now/deployments';
export const API_DEPLOYMENTS_LEGACY = '/v3/now/deployments';
export const API_DELETE_DEPLOYMENTS_LEGACY = '/v2/now/deployments';

export const EVENTS = new Set([
  // File events
  'hashes-calculated',
  'file_count',
  'file-uploaded',
  'all-files-uploaded',
  // Deployment events
  'created',
  'ready',
  'alias-assigned',
  'warning',
  'error',
  // Build events
  'build-state-changed',
]);

export async function parseNowJSON(filePath?: string): Promise<NowJsonOptions> {
  if (!filePath) {
    return {};
  }

  try {
    const jsonString = await readFile(filePath, 'utf8');

    return JSON.parse(jsonString);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);

    return {};
  }
}

const maybeRead = async function<T>(path: string, default_: T) {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    return default_;
  }
};

export async function getNowIgnore(path: string | string[]): Promise<any> {
  let ignores: string[] = [
    '.hg',
    '.git',
    '.gitmodules',
    '.svn',
    '.cache',
    '.next',
    '.now',
    '.npmignore',
    '.dockerignore',
    '.gitignore',
    '.*.swp',
    '.DS_Store',
    '.wafpicke-*',
    '.lock-wscript',
    '.env',
    '.env.build',
    '.venv',
    'npm-debug.log',
    'config.gypi',
    'node_modules',
    '__pycache__/',
    'venv/',
    'CVS',
  ];

  const nowIgnore = Array.isArray(path)
    ? await maybeRead(
        join(
          path.find(fileName => fileName.includes('.nowignore'), '') || '',
          '.nowignore'
        ),
        ''
      )
    : await maybeRead(join(path, '.nowignore'), '');

  const ig = ignore().add(`${ignores.join('\n')}\n${nowIgnore}`);

  return { ig, ignores };
}

export const fetch = async (
  url: string,
  token: string,
  opts: any = {},
  debugEnabled?: boolean
): Promise<any> => {
  semaphore.acquire();
  const debug = createDebug(debugEnabled);
  let time: number;

  url = `${opts.apiUrl || 'https://api.zeit.co'}${url}`;
  delete opts.apiUrl;

  if (opts.teamId) {
    const parsedUrl = parseUrl(url, true);
    const query = parsedUrl.query;

    query.teamId = opts.teamId;
    url = `${parsedUrl.href}?${qs.encode(query)}`;
    delete opts.teamId;
  }

  opts.headers = opts.headers || {};
  // @ts-ignore
  opts.headers.Authorization = `Bearer ${token}`;
  // @ts-ignore
  opts.headers['user-agent'] = `now-client-v${pkg.version}`;

  debug(`${opts.method || 'GET'} ${url}`);
  time = Date.now();
  const res = await fetch_(url, opts);
  debug(`DONE in ${Date.now() - time}ms: ${opts.method || 'GET'} ${url}`);
  semaphore.release();

  return res;
};

export interface PreparedFile {
  file: string;
  sha: string;
  size: number;
}

const isWin = process.platform.includes('win');

export const prepareFiles = (
  files: Map<string, DeploymentFile>,
  options: Options
): PreparedFile[] => {
  const preparedFiles = [...files.keys()].reduce(
    (acc: PreparedFile[], sha: string): PreparedFile[] => {
      const next = [...acc];

      const file = files.get(sha) as DeploymentFile;

      for (const name of file.names) {
        let fileName;

        if (options.isDirectory) {
          // Directory
          fileName = options.path
            ? name.substring(options.path.length + 1)
            : name;
        } else {
          // Array of files or single file
          const segments = name.split(sep);
          fileName = segments[segments.length - 1];
        }

        next.push({
          file: isWin ? fileName.replace(/\\/g, '/') : fileName,
          size: file.data.byteLength || file.data.length,
          sha,
        });
      }

      return next;
    },
    []
  );

  return preparedFiles;
};

export function createDebug(debug?: boolean) {
  const isDebug = debug || process.env.NOW_CLIENT_DEBUG;

  if (isDebug) {
    return (...logs: string[]) => {
      process.stderr.write(
        [`[now-client-debug] ${new Date().toISOString()}`, ...logs].join(' ') +
          '\n'
      );
    };
  }

  return () => {};
}
