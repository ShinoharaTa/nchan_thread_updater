import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import slowDown from 'express-slow-down';
import helmet from 'helmet';
import ChannelDatabase, { type Channel, type ChannelWithMessages } from './database.js';

export class ChannelAPI {
  private app: express.Application;
  private db: ChannelDatabase;
  private server: any;
  private isDevelopment: boolean;

  constructor(db: ChannelDatabase, port: number = 3000) {
    this.app = express();
    this.db = db;
    this.isDevelopment = process.env.NODE_ENV !== 'production';
    this.setupSecurity();
    this.setupMiddleware();
    this.setupRoutes();
    this.server = this.app.listen(port, () => {
      console.log(`Channel API server running on port ${port}`);
      console.log(`Environment: ${this.isDevelopment ? 'Development' : 'Production'}`);
    });
  }

  private setupSecurity() {
    // セキュリティヘッダーの設定
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
        },
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
    }));

    // レート制限の設定
    const createRateLimit = rateLimit({
      windowMs: 15 * 60 * 1000, // 15分
      max: this.isDevelopment ? 1000 : 100, // 開発時は緩く、本番は厳しく
      message: {
        error: 'Too many requests from this IP, please try again later.',
        retryAfter: '15 minutes'
      },
      standardHeaders: true,
      legacyHeaders: false,
    });

    // スロー制限の設定
    const createSlowDown = slowDown({
      windowMs: 15 * 60 * 1000, // 15分
      delayAfter: this.isDevelopment ? 500 : 50, // 開発時は緩く
      delayMs: 100, // 100ms遅延
      maxDelayMs: 5000, // 最大5秒遅延
    });

    this.app.use('/api', createRateLimit);
    this.app.use('/api', createSlowDown);

    // 基本的なレート制限（APIプレフィックスなし）
    this.app.use(rateLimit({
      windowMs: 1 * 60 * 1000, // 1分
      max: this.isDevelopment ? 500 : 200,
      message: { error: 'Rate limit exceeded' },
      standardHeaders: true,
      legacyHeaders: false,
    }));
  }

  private setupMiddleware() {
    // CORS設定の強化
    const allowedOrigins = process.env.ALLOWED_ORIGINS 
      ? process.env.ALLOWED_ORIGINS.split(',')
      : this.isDevelopment 
        ? ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000']
        : []; // 本番環境では明示的に指定

    this.app.use(cors({
      origin: (origin, callback) => {
        // 開発環境では全許可、本番環境では制限
        if (this.isDevelopment || !origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      methods: ['GET'], // 読み取り専用APIなのでGETのみ
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: false,
      maxAge: 86400, // 24時間キャッシュ
    }));
    
    // JSONパーシング（サイズ制限付き）
    this.app.use(express.json({ limit: '10kb' }));
    
    // リクエストサイズ制限
    this.app.use(express.urlencoded({ limit: '10kb', extended: true }));
    
    // セキュリティロギング
    this.app.use((req, res, next) => {
      const start = Date.now();
      const ip = req.ip || req.connection.remoteAddress || 'unknown';
      
      res.on('finish', () => {
        const duration = Date.now() - start;
        const logLevel = res.statusCode >= 400 ? 'WARN' : 'INFO';
        console.log(`[${logLevel}] ${ip} ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
        
        // 疑わしいアクティビティのログ
        if (res.statusCode === 429) {
          console.warn(`[SECURITY] Rate limit exceeded: ${ip} ${req.method} ${req.path}`);
        }
      });
      
      next();
    });
  }

  private setupRoutes() {
    // ================================
    // 公開対象APIエンドポイント（3つ）
    // ================================
    
    // ヘルスチェック
    this.app.get('/health', (req, res) => {
      // キャッシュ制御ヘッダーの設定（1分間キャッシュ）
      res.set({
        'Cache-Control': 'public, max-age=60, s-maxage=60',
        'Vary': 'Accept-Encoding'
      });
      
      res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
    });

    // チャンネル一覧取得（メインAPI）
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

        // キャッシュ制御ヘッダーの設定（1分間キャッシュ）
        res.set({
          'Cache-Control': 'public, max-age=60, s-maxage=60',
          'Vary': 'Accept-Encoding',
          'ETag': `"channels-${sort}-${limit}-${withMessages}-${Date.now().toString(36)}"`
        });

        res.json({
          data: channels,
          meta: {
            count: channels.length,
            sort,
            limit,
            with_messages: withMessages,
            timestamp: new Date().toISOString()
          }
        });
      } catch (error) {
        console.error('Error fetching channels:', error);
        res.status(500).json({ 
          error: 'Internal server error',
          ...(this.isDevelopment && { details: error.message })
        });
      }
    });

    // ================================
    // 非公開エンドポイント（将来的に公開検討）
    // ================================
    
    // 特定チャンネル詳細取得 - 現在公開対象外
    /*
    this.app.get('/channels/:id', (req, res) => {
      try {
        const { id } = req.params;
        
        // IDパラメータの検証（64文字のhex文字列想定）
        if (!id || !/^[a-fA-F0-9]{64}$/.test(id)) {
          return res.status(400).json({ 
            error: 'Invalid channel ID format',
            expected: '64-character hexadecimal string'
          });
        }
        
        const channel = this.db.getChannel(id);
        
        if (!channel) {
          return res.status(404).json({ error: 'Channel not found' });
        }

        const messages = this.db.getChannelMessages(id, 10);
        
        // キャッシュ制御ヘッダーの設定（3分間キャッシュ）
        res.set({
          'Cache-Control': 'public, max-age=180, s-maxage=180',
          'Vary': 'Accept-Encoding',
          'ETag': `"channel-${id}-${channel.latest_update}"`
        });
        
        res.json({
          data: {
            ...channel,
            events: messages.map(msg => ({
              content: msg.content,
              pubkey: msg.pubkey,
              created_at: msg.created_at
            }))
          },
          meta: {
            timestamp: new Date().toISOString()
          }
        });
      } catch (error) {
        console.error('Error fetching channel:', error);
        res.status(500).json({ 
          error: 'Internal server error',
          ...(this.isDevelopment && { details: error.message })
        });
      }
    });
    */

    // チャンネルメッセージ一覧 - 現在公開対象外
    /*
    this.app.get('/channels/:id/messages', (req, res) => {
      try {
        const { id } = req.params;
        const limit = parseInt(req.query.limit as string) || 20;

        // IDパラメータの検証
        if (!id || !/^[a-fA-F0-9]{64}$/.test(id)) {
          return res.status(400).json({ 
            error: 'Invalid channel ID format',
            expected: '64-character hexadecimal string'
          });
        }

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
        
        // キャッシュ制御ヘッダーの設定（2分間キャッシュ）
        res.set({
          'Cache-Control': 'public, max-age=120, s-maxage=120',
          'Vary': 'Accept-Encoding',
          'ETag': `"messages-${id}-${limit}-${messages.length}"`
        });
        
        res.json({
          data: messages,
          meta: {
            channel_id: id,
            count: messages.length,
            limit,
            timestamp: new Date().toISOString()
          }
        });
      } catch (error) {
        console.error('Error fetching channel messages:', error);
        res.status(500).json({ 
          error: 'Internal server error',
          ...(this.isDevelopment && { details: error.message })
        });
      }
    });
    */

    // チャンネルメタデータ履歴 - 現在公開対象外
    /*
    this.app.get('/channels/:id/history', (req, res) => {
      try {
        const { id } = req.params;
        const limit = parseInt(req.query.limit as string) || 10;

        // IDパラメータの検証
        if (!id || !/^[a-fA-F0-9]{64}$/.test(id)) {
          return res.status(400).json({ 
            error: 'Invalid channel ID format',
            expected: '64-character hexadecimal string'
          });
        }

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
        
        // キャッシュ制御ヘッダーの設定（10分間キャッシュ、履歴は変更頻度が低い）
        res.set({
          'Cache-Control': 'public, max-age=600, s-maxage=600',
          'Vary': 'Accept-Encoding',
          'ETag': `"history-${id}-${limit}-${history.length}"`
        });
        
        res.json({
          data: history,
          meta: {
            channel_id: id,
            count: history.length,
            limit,
            timestamp: new Date().toISOString()
          }
        });
      } catch (error) {
        console.error('Error fetching channel history:', error);
        res.status(500).json({ 
          error: 'Internal server error',
          ...(this.isDevelopment && { details: error.message })
        });
      }
    });
    */

    // 統計情報（3つ目の公開API）
    this.app.get('/stats', (req, res) => {
      try {
        const stats = this.db.getChannelStats();
        const lastSync = this.db.getLastSyncTime();
        
        // キャッシュ制御ヘッダーの設定（5分間キャッシュ）
        res.set({
          'Cache-Control': 'public, max-age=300, s-maxage=300',
          'Vary': 'Accept-Encoding',
          'ETag': `"stats-${lastSync}"`
        });
        
        res.json({
          data: {
            ...stats,
            last_sync_time: lastSync,
            last_sync_human: new Date(lastSync * 1000).toISOString()
          },
          meta: {
            timestamp: new Date().toISOString()
          }
        });
      } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ 
          error: 'Internal server error',
          ...(this.isDevelopment && { details: error.message })
        });
      }
    });

    // 404ハンドラー
    this.app.use((req, res) => {
      res.status(404).json({ error: 'Endpoint not found' });
    });

    // CORS エラーハンドラー
    this.app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (error.message === 'Not allowed by CORS') {
        console.warn(`[SECURITY] CORS violation: ${req.ip} attempted to access from unauthorized origin`);
        return res.status(403).json({ 
          error: 'Access denied - unauthorized origin',
          code: 'CORS_VIOLATION'
        });
      }
      next(error);
    });

    // 総合エラーハンドラー
    this.app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
      console.error('API Error:', error);
      
      const statusCode = error.name === 'ValidationError' ? 400 : 500;
      res.status(statusCode).json({ 
        error: statusCode === 400 ? 'Bad request' : 'Internal server error',
        ...(this.isDevelopment && { details: error.message, stack: error.stack })
      });
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