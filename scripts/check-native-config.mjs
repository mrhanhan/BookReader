#!/usr/bin/env node
// 校验桌面与 Android 发布配置的一致性。纯 Node 实现，不依赖任何第三方包。
// 退出码：全部通过为 0，任一失败为 1。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_APP_ID = 'com.bookr.reader';
const EXPECTED_ICONS = ['icon.ico', '32x32.png', '128x128.png', '128x128@2x.png'];
const REQUIRED_IGNORES = ['keystore.properties', '*.jks', '*.keystore'];

const failedChecks = [];

function readText(relPath) {
  return readFileSync(resolve(ROOT, relPath), 'utf8');
}

function readJson(relPath) {
  return JSON.parse(readText(relPath));
}

// 剔除 // 与 /* */ 注释，避免正则命中注释掉的配置行。
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function describeVersion(label, value) {
  return `${label}=${value ?? '<缺失>'}`;
}

function runCheck(index, total, title, check) {
  const errors = [];
  let summary = '';
  try {
    summary = check(errors) ?? '';
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (errors.length === 0) {
    console.log(`OK   [${index}/${total}] ${title}${summary ? `: ${summary}` : ''}`);
    return;
  }

  failedChecks.push(title);
  console.log(`FAIL [${index}/${total}] ${title}${summary ? `: ${summary}` : ''}`);
  for (const error of errors) {
    console.log(`     - ${error}`);
  }
}

function readCapacitorAppId() {
  const source = readText('apps/mobile/capacitor.config.ts');
  const match = source.match(/appId:\s*['"]([^'"]+)['"]/);
  if (!match) {
    throw new Error('apps/mobile/capacitor.config.ts 中找不到 appId');
  }
  return match[1];
}

const TOTAL = 6;

// 1. 桌面、移动 package.json 与 tauri.conf.json 的版本号一致。
runCheck(1, TOTAL, '版本号一致', (errors) => {
  const desktop = readJson('apps/desktop/package.json').version;
  const mobile = readJson('apps/mobile/package.json').version;
  const tauri = readJson('apps/desktop/src-tauri/tauri.conf.json').version;

  for (const [label, value] of Object.entries({ desktop, mobile, tauri })) {
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`${label} 的 version 缺失或不是非空字符串`);
    }
  }

  if (desktop !== mobile) {
    errors.push(
      `apps/desktop/package.json (${desktop}) 与 apps/mobile/package.json (${mobile}) 版本不一致`,
    );
  }
  if (tauri !== desktop) {
    errors.push(
      `tauri.conf.json (${tauri}) 与 apps/desktop/package.json (${desktop}) 版本不一致`,
    );
  }

  return [describeVersion('desktop', desktop), describeVersion('mobile', mobile), describeVersion('tauri', tauri)].join(', ');
});

// 2. 桌面与移动使用同一个应用标识 com.bookr.reader。
runCheck(2, TOTAL, '应用标识一致', (errors) => {
  const identifier = readJson('apps/desktop/src-tauri/tauri.conf.json').identifier;
  const appId = readCapacitorAppId();

  if (identifier !== EXPECTED_APP_ID) {
    errors.push(`tauri.conf.json identifier 为 ${identifier ?? '<缺失>'}，期望 ${EXPECTED_APP_ID}`);
  }
  if (appId !== EXPECTED_APP_ID) {
    errors.push(`capacitor.config.ts appId 为 ${appId ?? '<缺失>'}，期望 ${EXPECTED_APP_ID}`);
  }
  if (identifier !== appId) {
    errors.push(`tauri identifier (${identifier ?? '<缺失>'}) 与 capacitor appId (${appId ?? '<缺失>'}) 不一致`);
  }

  return `identifier=${identifier ?? '<缺失>'}, appId=${appId ?? '<缺失>'}`;
});

// 3. Android applicationId / versionName 与服务端契约（capacitor、mobile package.json）一致。
runCheck(3, TOTAL, 'Android 标识与版本', (errors) => {
  const gradle = stripComments(readText('apps/mobile/android/app/build.gradle'));
  const appId = readCapacitorAppId();
  const mobileVersion = readJson('apps/mobile/package.json').version;

  const applicationId = gradle.match(/applicationId\s+['"]([^'"]+)['"]/)?.[1];
  const versionName = gradle.match(/versionName\s+['"]([^'"]+)['"]/)?.[1];

  if (!applicationId) {
    errors.push('app/build.gradle 中找不到 applicationId');
  } else if (applicationId !== appId) {
    errors.push(`build.gradle applicationId (${applicationId}) 与 capacitor appId (${appId}) 不一致`);
  }

  if (!versionName) {
    errors.push('app/build.gradle 中找不到 versionName');
  } else if (versionName !== mobileVersion) {
    errors.push(
      `build.gradle versionName (${versionName}) 与 apps/mobile/package.json (${mobileVersion}) 不一致`,
    );
  }

  return `applicationId=${applicationId ?? '<缺失>'}, versionName=${versionName ?? '<缺失>'}`;
});

// 4. 签名材料 keystore.properties 必须被 Android .gitignore 忽略。
runCheck(4, TOTAL, '签名材料不入库', (errors) => {
  const gitignorePath = 'apps/mobile/android/.gitignore';
  if (!existsSync(resolve(ROOT, gitignorePath))) {
    throw new Error(`${gitignorePath} 不存在`);
  }

  const patterns = readText(gitignorePath)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.replace(/^\/+/, ''));

  const missing = REQUIRED_IGNORES.filter((pattern) => !patterns.includes(pattern));
  if (missing.length > 0) {
    errors.push(`${gitignorePath} 未忽略：${missing.join(', ')}`);
  }

  return missing.length === 0 ? `${REQUIRED_IGNORES.join(', ')} 均已忽略` : '';
});

// 5. 桌面打包所需图标齐全。
runCheck(5, TOTAL, '桌面图标齐全', (errors) => {
  const missing = EXPECTED_ICONS.filter(
    (icon) => !existsSync(resolve(ROOT, 'apps/desktop/src-tauri/icons', icon)),
  );
  if (missing.length > 0) {
    errors.push(`apps/desktop/src-tauri/icons 缺少：${missing.join(', ')}`);
  }

  return missing.length === 0 ? EXPECTED_ICONS.join(', ') : '';
});

// 6. Web 应用清单存在且为 standalone，可安装为 PWA。
runCheck(6, TOTAL, 'PWA 清单可安装', (errors) => {
  const manifestPath = 'apps/web/public/manifest.webmanifest';
  if (!existsSync(resolve(ROOT, manifestPath))) {
    throw new Error(`${manifestPath} 不存在`);
  }

  const manifest = readJson(manifestPath);
  if (manifest.display !== 'standalone') {
    errors.push(`${manifestPath} 的 display 为 ${manifest.display ?? '<缺失>'}，期望 standalone`);
  }

  return manifest.display === 'standalone' ? 'display=standalone' : '';
});

if (failedChecks.length > 0) {
  console.error(`\n原生发布配置检查失败：${failedChecks.length}/${TOTAL} 项未通过（${failedChecks.join('、')}）`);
  process.exit(1);
}

console.log(`\n原生发布配置检查通过：${TOTAL}/${TOTAL} 项全部 OK`);
