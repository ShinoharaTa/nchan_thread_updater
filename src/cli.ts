import { currUnixtime } from "./utils.js";

export interface RefreshOptions {
  mode: 'server' | 'refresh';
  since?: number;
  until?: number;
  force?: boolean;
}

export function parseCliArgs(): RefreshOptions {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    return { mode: 'server' };
  }

  const options: RefreshOptions = { mode: 'server' };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === 'refresh' || arg === '--refresh') {
      options.mode = 'refresh';
      continue;
    }
    
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    
    if (arg.startsWith('since=')) {
      const dateStr = arg.split('=')[1];
      options.since = parseDateToUnix(dateStr);
      continue;
    }
    
    if (arg.startsWith('until=')) {
      const dateStr = arg.split('=')[1];
      options.until = parseDateToUnix(dateStr);
      continue;
    }
    

  }

  return options;
}

function parseDateToUnix(dateStr: string): number {
  // YYYY-MM-DD形式をサポート
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const date = new Date(dateStr + 'T00:00:00Z');
    return Math.floor(date.getTime() / 1000);
  }
  
  // YYYY-MM-DD HH:mm:ss形式をサポート
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateStr)) {
    const date = new Date(dateStr + 'Z');
    return Math.floor(date.getTime() / 1000);
  }
  
  // Unix タイムスタンプの場合
  const timestamp = parseInt(dateStr);
  if (!isNaN(timestamp)) {
    return timestamp;
  }
  
  // ISO 8601形式
  const date = new Date(dateStr);
  if (!isNaN(date.getTime())) {
    return Math.floor(date.getTime() / 1000);
  }
  
  throw new Error(`Invalid date format: ${dateStr}. Use YYYY-MM-DD, YYYY-MM-DD HH:mm:ss, or Unix timestamp`);
}

export function printUsage() {
  console.log(`
Nostr Channel Thread List System

使用方法:
  npm start                          # APIサーバーとして起動
  npm run refresh                    # 全データをリフレッシュ
  npm run refresh -- since=2025-01-01 until=2025-01-31  # 期間指定リフレッシュ

コマンド:
  (なし)                            # APIサーバーモード
  refresh                           # リフレッシュモード

オプション:
  since=YYYY-MM-DD                  # 開始日時を指定（since～現在まで取得）
  until=YYYY-MM-DD                  # 終了日時を指定（最古～untilまで取得）
  --force                           # 全データを削除して強制更新

日時形式:
  YYYY-MM-DD                        # 例: 2025-01-01
  YYYY-MM-DD HH:mm:ss              # 例: 2025-01-01 12:30:00
  Unix timestamp                    # 例: 1735689600

使用例:
  npm start                                           # APIサーバー起動（初回はデータなし）
  npm run refresh                                     # 全件リフレッシュ
  npm run refresh -- since=2025-01-01                # 2025年1月1日以降を取得
  npm run refresh -- until=2025-01-31                # 2025年1月31日までを取得
  npm run refresh -- since=2025-01-01 until=2025-01-31  # 1月分のみ取得
  npm run refresh -- since=1735689600 --force        # Unix時刻指定+強制更新（全データ削除）
`);
}

export function validateRefreshOptions(options: RefreshOptions): string[] {
  const errors: string[] = [];
  
  if (options.mode === 'refresh') {
    if (options.since && options.until && options.since >= options.until) {
      errors.push('since must be earlier than until');
    }
    
    const now = currUnixtime();
    if (options.since && options.since > now) {
      errors.push('since cannot be in the future');
    }
    
    if (options.until && options.until > now) {
      errors.push('until cannot be in the future');
    }
  }
  
  return errors;
} 