import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type {
  DatabaseBackupInfo,
  DiscoveredDomain,
  ServerRecord,
} from '@/types';
import { isJobCancelled } from './worker-state';

/**
 * Mô phỏng sao lưu thực tế trên ổ cứng Local cho các máy chủ Demo (is_mock = 1),
 * sử dụng Hard Link thật (fs.linkSync) để kiểm thử Incremental, Explorer, Diff Viewer & Sandbox Verify!
 */
export async function executeMockServerBackup(params: {
  jobId: number;
  server: ServerRecord;
  domainInfo: DiscoveredDomain;
  snapshotName: string;
  destPublicHtmlDir: string;
  destDatabasesDir: string;
  linkDestPublicHtmlDir: string | null;
  onProgress: (pct: number, speedBps: number, etaSec: number) => void;
  onLog: (msg: string) => void;
}): Promise<{
  filesTotal: number;
  filesChanged: number;
  totalBytes: number;
  deltaBytes: number;
  dbResults: DatabaseBackupInfo[];
}> {
  const {
    jobId,
    server,
    domainInfo,
    snapshotName,
    destPublicHtmlDir,
    destDatabasesDir,
    linkDestPublicHtmlDir,
    onProgress,
    onLog,
  } = params;

  fs.mkdirSync(destPublicHtmlDir, { recursive: true });
  fs.mkdirSync(path.join(destPublicHtmlDir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(destPublicHtmlDir, 'includes'), { recursive: true });
  fs.mkdirSync(destDatabasesDir, { recursive: true });

  const staticFiles: Record<string, string> = {
    '.htaccess': `# BEGIN NAS-Sync Optimized Rewrite\nRewriteEngine On\nRewriteBase /\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule . /index.php [L]\n# END Rewrite\n`,
    'assets/style.css': `/* Theme stylesheet for ${domainInfo.domain} */\nbody { font-family: system-ui, sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }\n.container { max-width: 1200px; margin: 0 auto; padding: 2rem; }\n`,
    'includes/bootstrap.php': `<?php\n// Core bootstrapper for ${domainInfo.domain}\ndefine('APP_ENV', 'production');\ndefine('PANEL_ORIGIN', '${server.panel_type}');\ndefine('SYS_USER', '${domainInfo.systemUser}');\n`,
    'robots.txt': `User-agent: *\nAllow: /\nSitemap: https://${domainInfo.domain}/sitemap.xml\n`,
  };

  const dynamicFiles: Record<string, string> = {
    'index.php': `<?php\n/**\n * Website: ${domainInfo.domain}\n * Hosted on: ${server.hostname} (${server.panel_type})\n * Snapshot Version: ${snapshotName}\n */\nrequire_once __DIR__ . '/includes/bootstrap.php';\nrequire_once __DIR__ . '/wp-config.php';\n\n$buildVersion = '${snapshotName}';\n$activeVisitors = ${Math.floor(
      120 + Math.random() * 500
    )};\necho "<h1>Welcome to ${domainInfo.domain} — Build " . htmlspecialchars($buildVersion) . "</h1>";\n`,
    'wp-config.php': `<?php\ndefine('DB_NAME', '${
      domainInfo.databases[0]?.name || 'app_db'
    }');\ndefine('DB_USER', '${
      domainInfo.databases[0]?.user || domainInfo.systemUser
    }');\ndefine('DB_HOST', 'localhost');\ndefine('WP_CACHE', true);\ndefine('NAS_SYNC_LAST_RUN', '${new Date().toISOString()}');\n`,
  };

  let filesTotal = 0;
  let filesChanged = 0;
  let totalBytes = 0;
  let deltaBytes = 0;

  const steps = 4;
  for (let s = 1; s <= steps; s++) {
    if (isJobCancelled(jobId)) {
      throw new Error('Job đã bị hủy bởi quản trị viên.');
    }
    await new Promise((r) => setTimeout(r, 260));
    onProgress(
      Math.round((s / steps) * 100),
      18 * 1024 * 1024 + Math.floor(Math.random() * 8 * 1024 * 1024),
      Math.max(1, steps - s)
    );
  }

  for (const [relPath, content] of Object.entries(staticFiles)) {
    filesTotal++;
    const destFile = path.join(destPublicHtmlDir, relPath);
    const prevFile = linkDestPublicHtmlDir
      ? path.join(linkDestPublicHtmlDir, relPath)
      : null;

    if (prevFile && fs.existsSync(prevFile)) {
      try {
        if (fs.existsSync(destFile)) fs.unlinkSync(destFile);
        fs.linkSync(prevFile, destFile);
        const sz = fs.statSync(destFile).size;
        totalBytes += sz;
        continue;
      } catch {
        // Fallback ghi thường nếu khác ổ đĩa
      }
    }
    fs.writeFileSync(destFile, content, 'utf8');
    const sz = Buffer.byteLength(content, 'utf8');
    totalBytes += sz;
    deltaBytes += sz;
    filesChanged++;
  }

  for (const [relPath, content] of Object.entries(dynamicFiles)) {
    filesTotal++;
    filesChanged++;
    const destFile = path.join(destPublicHtmlDir, relPath);
    fs.writeFileSync(destFile, content, 'utf8');
    const sz = Buffer.byteLength(content, 'utf8');
    totalBytes += sz;
    deltaBytes += sz;
  }

  onLog(
    `[Incremental Sync] ${domainInfo.domain}: Tổng ${filesTotal} files, thay đổi ${filesChanged} files (Hard-linked ${
      filesTotal - filesChanged
    } files từ bản latest).`
  );

  const dbResults: DatabaseBackupInfo[] = [];
  const zlibWithZstd = zlib as typeof zlib & {
    zstdCompressSync?: (buf: Buffer) => Buffer;
  };

  for (const dbItem of domainInfo.databases) {
    if (dbItem.engine === 'POSTGRESQL') {
      const pgSqlContent = `--
-- PostgreSQL database dump
--
-- Dumped from database version 16.4
-- Dumped by pg_dump version 16.4
-- Host: ${server.hostname}    Database: ${dbItem.name}
-- Panel: ${server.panel_type}    Snapshot: ${snapshotName}

SET statement_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

CREATE TABLE IF NOT EXISTS public.app_settings (
    id bigint PRIMARY KEY,
    setting_key character varying(191) NOT NULL,
    setting_value text NOT NULL
);

INSERT INTO public.app_settings (id, setting_key, setting_value) VALUES
(1, 'site_domain', 'https://${domainInfo.domain}'),
(2, 'snapshot_tag', '${snapshotName}');

CREATE TABLE IF NOT EXISTS public.audit_events (
    id bigint PRIMARY KEY,
    event_name character varying(120) NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

INSERT INTO public.audit_events (id, event_name) VALUES
(1, 'nas_sync_pg_stream_${snapshotName}');

--
-- PostgreSQL database dump complete
--
`;
      const rawBuf = Buffer.from(pgSqlContent, 'utf8');
      const useZstd = typeof zlibWithZstd.zstdCompressSync === 'function';
      const compressed = useZstd
        ? zlibWithZstd.zstdCompressSync!(rawBuf)
        : zlib.gzipSync(rawBuf);
      const fileName = useZstd
        ? `pg_${dbItem.name}.sql.zst`
        : `pg_${dbItem.name}.sql.gz`;
      const dumpPath = path.join(destDatabasesDir, fileName);
      fs.writeFileSync(dumpPath, compressed);

      totalBytes += compressed.length;
      deltaBytes += compressed.length;

      onLog(
        `[PG Stream] Đã stream trực tiếp PostgreSQL ${dbItem.name} ➔ ${fileName} (${(
          compressed.length / 1024
        ).toFixed(2)} KB).`
      );

      dbResults.push({
        name: dbItem.name,
        db_user: dbItem.user,
        engine: 'POSTGRESQL',
        file: fileName,
        size_bytes: compressed.length,
      });
      continue;
    }

    const sqlContent = `-- NAS-Sync SQL Stream Dump
-- Host: ${server.hostname}    Database: ${dbItem.name}
-- Panel: ${server.panel_type}    Snapshot: ${snapshotName}
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS \`wp_options\` (
  \`option_id\` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  \`option_name\` varchar(191) NOT NULL DEFAULT '',
  \`option_value\` longtext NOT NULL,
  PRIMARY KEY (\`option_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO \`wp_options\` (\`option_name\`, \`option_value\`) VALUES
('siteurl', 'https://${domainInfo.domain}'),
('blogname', '${domainInfo.domain} Enterprise Portal'),
('snapshot_tag', '${snapshotName}');

CREATE TABLE IF NOT EXISTS \`wp_posts\` (
  \`ID\` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  \`post_title\` text NOT NULL,
  \`post_status\` varchar(20) NOT NULL DEFAULT 'publish',
  PRIMARY KEY (\`ID\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO \`wp_posts\` (\`post_title\`, \`post_status\`) VALUES
('Chào mừng tới hệ thống ${domainInfo.domain}', 'publish'),
('Bản ghi đồng bộ lúc ${new Date().toISOString()}', 'publish');

SET FOREIGN_KEY_CHECKS = 1;
-- Dump completed on ${new Date().toISOString()}
`;
    const compressed = zlib.gzipSync(Buffer.from(sqlContent, 'utf8'));
    const fileName = `${dbItem.name}.sql.gz`;
    const dumpPath = path.join(destDatabasesDir, fileName);
    fs.writeFileSync(dumpPath, compressed);

    totalBytes += compressed.length;
    deltaBytes += compressed.length;

    onLog(
      `[DB Stream] Đã stream trực tiếp ${dbItem.name} ➔ ${fileName} (${(
        compressed.length / 1024
      ).toFixed(2)} KB).`
    );

    dbResults.push({
      name: dbItem.name,
      db_user: dbItem.user,
      engine: 'MYSQL',
      file: fileName,
      size_bytes: compressed.length,
    });
  }

  return {
    filesTotal,
    filesChanged,
    totalBytes,
    deltaBytes,
    dbResults,
  };
}
