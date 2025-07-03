import express from 'express';
import cors from 'cors';
import ChannelDatabase, { type Channel, type ChannelWithMessages } from './database.js';

export class ChannelAPI {
  private app: express.Application;
  private db: ChannelDatabase;
  private server: any;

  constructor(db: ChannelDatabase, port: number = 3000) {
    this.app = express();
    this.db = db;
    this.setupMiddleware();
    this.setupRoutes();
    this.server = this.app.listen(port, () => {
      console.log(`Channel API server running on port ${port}`);
    });
  }

  private setupMiddleware() {
    // CORSを有効化
    this.app.use(cors());
    
    // JSONパーシング
    this.app.use(express.json());
    
    // レスポンス時間のロギング
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
      });
      next();
    });
  }

  private setupRoutes() {
    // ヘルスチェック
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
    });

    // チャンネル一覧取得
    this.app.get('/channels', (req, res) => {
      try {
        const sort = req.query.sort as 'latest' | 'oldest' | 'created_new' | 'created_old' || 'latest';
        const limit = parseInt(req.query.limit as string) || 50;
        const withMessages = req.query.with_messages === 'true';

        // バリデーション
        if (!['latest', 'oldest', 'created_new', 'created_old'].includes(sort)) {
          return res.status(400).json({ 
            error: 'Invalid sort parameter. Must be one of: latest, oldest, created_new, created_old' 
          });
        }

        if (limit < 1 || limit > 200) {
          return res.status(400).json({ 
            error: 'Invalid limit parameter. Must be between 1 and 200' 
          });
        }

        let channels: Channel[] | ChannelWithMessages[];
        
        if (withMessages) {
          channels = this.db.getChannelsWithMessages(limit, sort);
        } else {
          channels = this.db.getAllChannels(limit, sort);
        }

        res.json({
          data: channels,
          meta: {
            count: channels.length,
            sort,
            limit,
            with_messages: withMessages
          }
        });
      } catch (error) {
        console.error('Error fetching channels:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // 特定チャンネル詳細取得
    this.app.get('/channels/:id', (req, res) => {
      try {
        const { id } = req.params;
        const channel = this.db.getChannel(id);
        
        if (!channel) {
          return res.status(404).json({ error: 'Channel not found' });
        }

        const messages = this.db.getChannelMessages(id, 10);
        
        res.json({
          data: {
            ...channel,
            events: messages.map(msg => ({
              content: msg.content,
              pubkey: msg.pubkey,
              created_at: msg.created_at
            }))
          }
        });
      } catch (error) {
        console.error('Error fetching channel:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // チャンネルメッセージ一覧
    this.app.get('/channels/:id/messages', (req, res) => {
      try {
        const { id } = req.params;
        const limit = parseInt(req.query.limit as string) || 20;

        if (limit < 1 || limit > 100) {
          return res.status(400).json({ 
            error: 'Invalid limit parameter. Must be between 1 and 100' 
          });
        }

        const channel = this.db.getChannel(id);
        if (!channel) {
          return res.status(404).json({ error: 'Channel not found' });
        }

        const messages = this.db.getChannelMessages(id, limit);
        
        res.json({
          data: messages,
          meta: {
            channel_id: id,
            count: messages.length,
            limit
          }
        });
      } catch (error) {
        console.error('Error fetching channel messages:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // チャンネルメタデータ履歴
    this.app.get('/channels/:id/history', (req, res) => {
      try {
        const { id } = req.params;
        const limit = parseInt(req.query.limit as string) || 10;

        if (limit < 1 || limit > 50) {
          return res.status(400).json({ 
            error: 'Invalid limit parameter. Must be between 1 and 50' 
          });
        }

        const channel = this.db.getChannel(id);
        if (!channel) {
          return res.status(404).json({ error: 'Channel not found' });
        }

        const history = this.db.getChannelMetaHistory(id, limit);
        
        res.json({
          data: history,
          meta: {
            channel_id: id,
            count: history.length,
            limit
          }
        });
      } catch (error) {
        console.error('Error fetching channel history:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // 統計情報
    this.app.get('/stats', (req, res) => {
      try {
        const stats = this.db.getChannelStats();
        const lastSync = this.db.getLastSyncTime();
        
        res.json({
          data: {
            ...stats,
            last_sync_time: lastSync,
            last_sync_human: new Date(lastSync * 1000).toISOString()
          }
        });
      } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // 404ハンドラー
    this.app.use((req, res) => {
      res.status(404).json({ error: 'Endpoint not found' });
    });

    // エラーハンドラー
    this.app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
      console.error('API Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  public close() {
    if (this.server) {
      this.server.close(() => {
        console.log('API server closed');
      });
    }
  }
}

export default ChannelAPI; 