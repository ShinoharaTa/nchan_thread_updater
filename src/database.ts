import Database from 'better-sqlite3';
import path from 'path';

export interface Channel {
  id: string;
  author: string;
  name: string;
  content: string;
  latest_update: number;
  created_at: number;
}

export interface ChannelMessage {
  id: string;
  channel_id: string;
  content: string;
  pubkey: string;
  created_at: number;
}

export interface ChannelMeta {
  id: string;
  channel_id: string;
  kind: number; // 40 (creation) or 41 (metadata)
  content: string;
  pubkey: string;
  created_at: number;
}

export interface ChannelWithMessages extends Channel {
  events: {
    content: string;
    pubkey: string;
    created_at: number;
  }[];
}

class ChannelDatabase {
  private db: Database.Database;

  constructor(dbPath: string = './channels.db') {
    this.db = new Database(dbPath);
    this.initTables();
  }

  private initTables() {
    // チャンネルテーブル（現在の状態を保持）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        author TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        latest_update INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    
    // 既存テーブルの構造を確認し、必要に応じてカラムを追加
    this.migrateTableStructure();

    // チャンネルメッセージテーブル
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        content TEXT NOT NULL,
        pubkey TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (channel_id) REFERENCES channels(id)
      )
    `);

    // チャンネルメタデータ履歴テーブル（kind 40, 41の履歴）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_meta_history (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        kind INTEGER NOT NULL,
        content TEXT NOT NULL,
        pubkey TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (channel_id) REFERENCES channels(id)
      )
    `);

    // 同期情報テーブル
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_info (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      )
    `);

    // インデックス作成
    this.createIndexes();
  }

  private createIndexes() {
    // チャンネルテーブルのインデックス
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_channels_latest_update 
      ON channels(latest_update DESC)
    `);
    
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_channels_created_at 
      ON channels(created_at DESC)
    `);

    // メッセージテーブルのインデックス
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_channel_created 
      ON channel_messages(channel_id, created_at DESC)
    `);

    // メタデータ履歴テーブルのインデックス
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_meta_history_channel 
      ON channel_meta_history(channel_id, created_at DESC)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_meta_history_kind 
      ON channel_meta_history(kind, created_at DESC)
    `);
  }

  // テーブル構造のマイグレーション
  private migrateTableStructure() {
    try {
      // channelsテーブルが存在するかチェック
      const tableExists = this.db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='channels'
      `).get();
      
      if (tableExists) {
        // テーブルが存在する場合、カラム構造をチェック
        const pragmaResult = this.db.prepare("PRAGMA table_info(channels)").all() as any[];
        const hasLatestUpdate = pragmaResult.some(column => column.name === 'latest_update');
        
        if (!hasLatestUpdate) {
          console.log('Adding latest_update column to existing channels table...');
          this.db.exec('ALTER TABLE channels ADD COLUMN latest_update INTEGER NOT NULL DEFAULT 0');
          
          // 既存データのlatest_updateをcreated_atで更新
          this.db.exec('UPDATE channels SET latest_update = created_at WHERE latest_update = 0');
          console.log('Migration completed: latest_update column added to existing table');
        } else {
          console.log('latest_update column already exists in channels table');
        }
      } else {
        console.log('channels table does not exist yet, will be created with latest_update column');
      }
    } catch (error) {
      console.error('Migration error:', error);
      console.error('Migration error details:', error.message);
    }
  }

  // チャンネルの保存・更新
  upsertChannel(channel: Channel): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO channels 
      (id, author, name, content, latest_update, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      channel.id,
      channel.author,
      channel.name,
      channel.content,
      channel.latest_update,
      channel.created_at
    );
  }

  // チャンネルメタデータ履歴の保存
  insertChannelMeta(meta: ChannelMeta): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO channel_meta_history 
      (id, channel_id, kind, content, pubkey, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      meta.id,
      meta.channel_id,
      meta.kind,
      meta.content,
      meta.pubkey,
      meta.created_at
    );
  }

  // チャンネル取得
  getChannel(id: string): Channel | null {
    const stmt = this.db.prepare('SELECT * FROM channels WHERE id = ?');
    return stmt.get(id) as Channel | null;
  }

  // 全チャンネル取得（ソート機能付き）
  getAllChannels(limit?: number, sort: 'latest' | 'oldest' | 'created_new' | 'created_old' = 'latest'): Channel[] {
    let orderBy: string;
    switch (sort) {
      case 'latest':
        orderBy = 'ORDER BY latest_update DESC';
        break;
      case 'oldest':
        orderBy = 'ORDER BY latest_update ASC';
        break;
      case 'created_new':
        orderBy = 'ORDER BY created_at DESC';
        break;
      case 'created_old':
        orderBy = 'ORDER BY created_at ASC';
        break;
      default:
        orderBy = 'ORDER BY latest_update DESC';
    }

    let sql = `SELECT * FROM channels ${orderBy}`;
    if (limit) {
      sql += ` LIMIT ${limit}`;
    }
    
    const stmt = this.db.prepare(sql);
    return stmt.all() as Channel[];
  }

  // チャンネルの最新更新時刻を更新
  updateChannelLatestTime(channelId: string, timestamp: number): void {
    const stmt = this.db.prepare(`
      UPDATE channels 
      SET latest_update = ? 
      WHERE id = ? AND latest_update < ?
    `);
    stmt.run(timestamp, channelId, timestamp);
  }

  // チャンネル名の更新
  updateChannelName(channelId: string, name: string, content: string, timestamp: number): void {
    const stmt = this.db.prepare(`
      UPDATE channels 
      SET name = ?, content = ?, latest_update = ?
      WHERE id = ?
    `);
    stmt.run(name, content, timestamp, channelId);
  }

  // メッセージの保存
  insertMessage(message: ChannelMessage): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO channel_messages 
      (id, channel_id, content, pubkey, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      message.id,
      message.channel_id,
      message.content,
      message.pubkey,
      message.created_at
    );
  }

  // チャンネルの最新メッセージ取得
  getChannelMessages(channelId: string, limit: number = 3): ChannelMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM channel_messages 
      WHERE channel_id = ? 
      ORDER BY created_at DESC 
      LIMIT ?
    `);
    return stmt.all(channelId, limit) as ChannelMessage[];
  }

  // チャンネルのメタデータ履歴取得
  getChannelMetaHistory(channelId: string, limit?: number): ChannelMeta[] {
    let sql = `
      SELECT * FROM channel_meta_history 
      WHERE channel_id = ? 
      ORDER BY created_at DESC
    `;
    
    if (limit) {
      sql += ` LIMIT ${limit}`;
    }

    const stmt = this.db.prepare(sql);
    return stmt.all(channelId) as ChannelMeta[];
  }

  // チャンネルとメッセージを結合して取得
  getChannelsWithMessages(limit: number = 50, sort: 'latest' | 'oldest' | 'created_new' | 'created_old' = 'latest'): ChannelWithMessages[] {
    const channels = this.getAllChannels(limit, sort);
    
    return channels.map(channel => {
      const messages = this.getChannelMessages(channel.id, 3);
      return {
        ...channel,
        events: messages.map(msg => ({
          content: msg.content,
          pubkey: msg.pubkey,
          created_at: msg.created_at
        }))
      };
    });
  }

  // チャンネル統計情報
  getChannelStats(): any {
    try {
      // まずテーブル構造を確認
      const tableExists = this.db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='channels'
      `).get();
      
      if (!tableExists) {
        console.log('channels table does not exist, returning empty stats');
        return {
          total_channels: 0,
          avg_last_update: 0,
          oldest_channel: 0,
          newest_channel: 0,
          total_messages: 0,
          total_meta_changes: 0
        };
      }
      
      // カラムの存在を確認
      const pragmaResult = this.db.prepare("PRAGMA table_info(channels)").all() as any[];
      const hasLatestUpdate = pragmaResult.some(column => column.name === 'latest_update');
      
      if (!hasLatestUpdate) {
        console.log('latest_update column missing, attempting migration...');
        this.migrateTableStructure();
      }
      
      const stmt = this.db.prepare(`
        SELECT 
          COUNT(*) as total_channels,
          COALESCE(AVG(latest_update), 0) as avg_last_update,
          COALESCE(MIN(created_at), 0) as oldest_channel,
          COALESCE(MAX(created_at), 0) as newest_channel,
          (SELECT COUNT(*) FROM channel_messages) as total_messages,
          (SELECT COUNT(*) FROM channel_meta_history) as total_meta_changes
      `);
      
      const result = stmt.get() as any;
      
      // 結果を安全に処理
      return {
        total_channels: result?.total_channels || 0,
        avg_last_update: result?.avg_last_update || 0,
        oldest_channel: result?.oldest_channel || 0,
        newest_channel: result?.newest_channel || 0,
        total_messages: result?.total_messages || 0,
        total_meta_changes: result?.total_meta_changes || 0
      };
    } catch (error) {
      console.error('Error in getChannelStats:', error);
      // エラーが発生した場合はデフォルト値を返す
      return {
        total_channels: 0,
        avg_last_update: 0,
        oldest_channel: 0,
        newest_channel: 0,
        total_messages: 0,
        total_meta_changes: 0
      };
    }
  }

  // 全チャンネル削除
  deleteAllChannels(): number {
    const stmt = this.db.prepare('DELETE FROM channels');
    const result = stmt.run();
    return result.changes || 0;
  }

  // 全メッセージ削除
  deleteAllMessages(): number {
    const stmt = this.db.prepare('DELETE FROM channel_messages');
    const result = stmt.run();
    return result.changes || 0;
  }

  // 全メタデータ履歴削除
  deleteAllMetaHistory(): number {
    const stmt = this.db.prepare('DELETE FROM channel_meta_history');
    const result = stmt.run();
    return result.changes || 0;
  }

  // リフレッシュ用: 期間内のチャンネル削除
  deleteChannelsInPeriod(since?: number, until?: number): number {
    let sql = 'DELETE FROM channels WHERE 1=1';
    const params: any[] = [];
    
    if (since) {
      sql += ' AND created_at >= ?';
      params.push(since);
    }
    
    if (until) {
      sql += ' AND created_at <= ?';
      params.push(until);
    }
    
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...params);
    return result.changes || 0;
  }

  // リフレッシュ用: 期間内のメッセージ削除
  deleteMessagesInPeriod(since?: number, until?: number): number {
    let sql = 'DELETE FROM channel_messages WHERE 1=1';
    const params: any[] = [];
    
    if (since) {
      sql += ' AND created_at >= ?';
      params.push(since);
    }
    
    if (until) {
      sql += ' AND created_at <= ?';
      params.push(until);
    }
    
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...params);
    return result.changes || 0;
  }

  // リフレッシュ用: 期間内のメタデータ履歴削除
  deleteMetaHistoryInPeriod(since?: number, until?: number): number {
    let sql = 'DELETE FROM channel_meta_history WHERE 1=1';
    const params: any[] = [];
    
    if (since) {
      sql += ' AND created_at >= ?';
      params.push(since);
    }
    
    if (until) {
      sql += ' AND created_at <= ?';
      params.push(until);
    }
    
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...params);
    return result.changes || 0;
  }

  // 既存チャンネルの確認（重複チェック用）
  channelExistsInPeriod(channelId: string, since?: number, until?: number): boolean {
    let sql = 'SELECT 1 FROM channels WHERE id = ?';
    const params: any[] = [channelId];
    
    if (since) {
      sql += ' AND created_at >= ?';
      params.push(since);
    }
    
    if (until) {
      sql += ' AND created_at <= ?';
      params.push(until);
    }
    
    const stmt = this.db.prepare(sql);
    return stmt.get(...params) !== undefined;
  }

  // リフレッシュ統計の取得
  getRefreshStats(since?: number, until?: number): any {
    let whereClause = 'WHERE 1=1';
    const params: any[] = [];
    
    if (since) {
      whereClause += ' AND created_at >= ?';
      params.push(since);
    }
    
    if (until) {
      whereClause += ' AND created_at <= ?';
      params.push(until);
    }

    const channelStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM channels ${whereClause}
    `);
    
    const messageStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM channel_messages ${whereClause}
    `);
    
    const metaStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM channel_meta_history ${whereClause}
    `);
    
    return {
      channels: channelStmt.get(...params),
      messages: messageStmt.get(...params),
      meta_history: metaStmt.get(...params),
      period: {
        since: since ? new Date(since * 1000).toISOString() : null,
        until: until ? new Date(until * 1000).toISOString() : null
      }
    };
  }

  // 最後に同期した時刻を保存/取得
  getLastSyncTime(): number {
    // sync_infoテーブルが存在しない場合は作成
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_info (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      )
    `);
    
    const stmt = this.db.prepare(`
      SELECT value FROM sync_info WHERE key = 'last_sync_time'
    `);
    
    const result = stmt.get() as { value: number } | undefined;
    return result?.value || 0;
  }

  setLastSyncTime(timestamp: number): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sync_info (key, value)
      VALUES ('last_sync_time', ?)
    `);
    stmt.run(timestamp);
  }

  // 古いメッセージの削除（メモリ節約）
  cleanupOldMessages(daysToKeep: number = 30): void {
    const cutoffTime = Math.floor(Date.now() / 1000) - (daysToKeep * 24 * 60 * 60);
    const stmt = this.db.prepare(`
      DELETE FROM channel_messages 
      WHERE created_at < ? 
      AND id NOT IN (
        SELECT id FROM channel_messages 
        WHERE channel_id = channel_messages.channel_id 
        ORDER BY created_at DESC 
        LIMIT 3
      )
    `);
    const result = stmt.run(cutoffTime);
    console.log(`Cleaned up ${result.changes} old messages`);
  }

  // 古いメタデータ履歴の削除
  cleanupOldMetaHistory(keepCount: number = 10): void {
    const stmt = this.db.prepare(`
      DELETE FROM channel_meta_history 
      WHERE id NOT IN (
        SELECT id FROM channel_meta_history 
        WHERE channel_id = channel_meta_history.channel_id 
        ORDER BY created_at DESC 
        LIMIT ?
      )
    `);
    const result = stmt.run(keepCount);
    console.log(`Cleaned up ${result.changes} old meta history records`);
  }

  close(): void {
    this.db.close();
  }
}

export default ChannelDatabase; 