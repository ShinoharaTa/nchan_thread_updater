import cron from "node-cron";

import { currUnixtime } from "./utils.js";
import { finishEvent, Kind, SimplePool } from "nostr-tools";
import type { Event, EventTemplate } from "nostr-tools";
import dotenv from "dotenv";
import "websocket-polyfill";
import ChannelDatabase, { type Channel, type ChannelMessage, type ChannelMeta } from "./database.js";
import ChannelAPI from "./api.js";
import { parseCliArgs, printUsage, validateRefreshOptions, type RefreshOptions } from "./cli.js";

dotenv.config();

const HEX: string = process.env.HEX ?? "";
const API_PORT: number = parseInt(process.env.API_PORT || "3000");
const HAS_POSTING_KEY: boolean = !!HEX;

if (!HEX) {
  console.log("⚠️  No HEX private key provided - running in read-only mode");
  console.log("   NIP-78 posting and system notifications will be disabled");
} else {
  console.log("🔑 HEX private key found - posting features enabled");
}

const RELAYS = [
  "wss://relay-jp.nostr.wirednet.jp",
  "wss://r.kojira.io",
  "wss://yabu.me",
  "wss://relay-jp.shino3.net",
];

const pool = new SimplePool();
const db = new ChannelDatabase();

const send = async (content: string, targetEvent: Event | null = null) => {
  if (!HAS_POSTING_KEY) {
    console.log("📝 Send skipped (read-only mode):", content);
    return;
  }
  
  const created = targetEvent ? targetEvent.created_at + 1 : currUnixtime();
  const ev: EventTemplate<Kind.Text> = {
    kind: Kind.Text,
    content: content,
    tags: [],
    created_at: created,
  };
  if (targetEvent) {
    ev.tags.push(["e", targetEvent.id]);
    ev.tags.push(["p", targetEvent.pubkey]);
  }
  const post = finishEvent(ev, HEX);
  return new Promise(() => {
    const pub = pool.publish(RELAYS, post);
    pub.on("failed", (ev) => {
      console.error("failed to send event", ev);
    });
  });
};

const nip78post = async (storeName: string, content: string) => {
  if (!HAS_POSTING_KEY) {
    console.log("🗃️  NIP-78 post skipped (read-only mode):", storeName);
    return;
  }
  
  const tags = [["d", storeName]];
  const ev = {
    kind: 30078,
    content,
    tags,
    created_at: currUnixtime(),
  };
  const post = finishEvent(ev, HEX);
  const pub = pool.publish(RELAYS, post);
  pub.on("failed", (ev) => {
    console.error("failed to send event", ev);
  });
};

// デバウンス処理用
let updateTimeout: NodeJS.Timeout | null = null;
const debouncedNip78Update = () => {
  if (!HAS_POSTING_KEY) {
    return; // 読み取り専用モードでは何もしない
  }
  
  if (updateTimeout) {
    clearTimeout(updateTimeout);
  }
  updateTimeout = setTimeout(() => {
    const sortedChannelList = db.getChannelsWithMessages(50);
    nip78post("nchan_list", JSON.stringify(sortedChannelList));
  }, 1000); // 1秒間の遅延
};

// 期間指定でのリフレッシュ処理
async function refreshChannelData(options: RefreshOptions): Promise<void> {
  console.log("🔄 Starting refresh operation...");
  
  const since = options.since;
  const until = options.until;
  
  // 期間の表示ロジックを明確化
  let periodDescription = '';
  if (since && until) {
    periodDescription = `${new Date(since * 1000).toISOString()} to ${new Date(until * 1000).toISOString()}`;
  } else if (since) {
    periodDescription = `${new Date(since * 1000).toISOString()} to now`;
  } else if (until) {
    periodDescription = `beginning to ${new Date(until * 1000).toISOString()}`;
  } else {
    periodDescription = 'beginning to now (all data)';
  }
  console.log(`Period: ${periodDescription}`);
  
  // 強制モードの場合、全データを削除
  if (options.force) {
    console.log("🗑️  Force mode: Clearing ALL existing data...");
    const deletedChannels = db.deleteAllChannels();
    const deletedMessages = db.deleteAllMessages();
    const deletedMeta = db.deleteAllMetaHistory();
    console.log(`Deleted: ${deletedChannels} channels, ${deletedMessages} messages, ${deletedMeta} meta records`);
  }

  // チャンネル作成イベントの取得
  console.log("📥 Fetching channel creation events...");
  const channelFilter: any = {
    kinds: [Kind.ChannelCreation],
    limit: 5000, // リフレッシュ時は多めに取得
  };
  
  if (since) channelFilter.since = since;
  if (until) channelFilter.until = until;

  const channels = await pool.list(RELAYS, [channelFilter]);
  console.log(`Found ${channels.length} channel creation events`);
  
  // デバッグ：期間外のデータがあるかチェック
  if (since || until) {
    const outOfRangeChannels = channels.filter(channel => {
      if (since && channel.created_at < since) return true;
      if (until && channel.created_at > until) return true;
      return false;
    });
    
    if (outOfRangeChannels.length > 0) {
      console.log(`⚠️  WARNING: Found ${outOfRangeChannels.length} channels outside specified period:`);
      outOfRangeChannels.slice(0, 5).forEach(channel => {
        console.log(`   - ${channel.id}: created_at=${channel.created_at} (${new Date(channel.created_at * 1000).toISOString()})`);
      });
      if (outOfRangeChannels.length > 5) {
        console.log(`   ... and ${outOfRangeChannels.length - 5} more`);
      }
    }
  }

  let processedChannels = 0;
  let skippedChannels = 0;

  // チャンネル作成イベントの処理
  for (const channel of channels) {
    try {
      // 期間チェック：指定期間外のデータはスキップ
      if (since && channel.created_at < since) {
        console.log(`Skipping channel ${channel.id} (created_at: ${channel.created_at} < since: ${since})`);
        skippedChannels++;
        continue;
      }
      if (until && channel.created_at > until) {
        console.log(`Skipping channel ${channel.id} (created_at: ${channel.created_at} > until: ${until})`);
        skippedChannels++;
        continue;
      }

      // 強制モードでない場合、既存チャンネルをスキップ
      if (!options.force && db.channelExistsInPeriod(channel.id, since, until)) {
        skippedChannels++;
        continue;
      }

      const parsedContent = JSON.parse(channel.content);
      const newChannel: Channel = {
        id: channel.id,
        author: channel.pubkey,
        name: parsedContent.name || "Untitled",
        content: channel.content,
        latest_update: channel.created_at,
        created_at: channel.created_at,
      };
      db.upsertChannel(newChannel);

      // メタデータ履歴に保存
      const meta: ChannelMeta = {
        id: channel.id,
        channel_id: channel.id,
        kind: 40,
        content: channel.content,
        pubkey: channel.pubkey,
        created_at: channel.created_at,
      };
      db.insertChannelMeta(meta);
      processedChannels++;
    } catch (error) {
      console.warn(`Failed to process channel ${channel.id}:`, error);
    }
  }

  console.log(`📊 Processed: ${processedChannels} channels, Skipped: ${skippedChannels} channels`);

  // メタデータイベントの取得
  console.log("📥 Fetching channel metadata events...");
  const metadataFilter: any = {
    kinds: [Kind.ChannelMetadata],
    limit: 10000,
  };
  
  if (since) metadataFilter.since = since;
  if (until) metadataFilter.until = until;

  const metadataEvents = await pool.list(RELAYS, [metadataFilter]);
  console.log(`Found ${metadataEvents.length} metadata events`);

  let processedMeta = 0;
  for (const metadata of metadataEvents) {
    try {
      // 期間チェック：指定期間外のデータはスキップ
      if (since && metadata.created_at < since) {
        continue;
      }
      if (until && metadata.created_at > until) {
        continue;
      }

      const root = metadata.tags.find((tag) => tag[0] === "e");
      if (!root) continue;
      
      const channelId = root[1];
      const channel = db.getChannel(channelId);
      if (!channel || channel.author !== metadata.pubkey) continue;

      // メタデータ履歴に保存
      const meta: ChannelMeta = {
        id: metadata.id,
        channel_id: channelId,
        kind: 41,
        content: metadata.content,
        pubkey: metadata.pubkey,
        created_at: metadata.created_at,
      };
      db.insertChannelMeta(meta);

      // 最新のメタデータの場合、チャンネル情報を更新
      if (metadata.created_at > channel.created_at) {
        const updateContent = JSON.parse(metadata.content);
        db.updateChannelName(
          channelId,
          updateContent.name || channel.name,
          metadata.content,
          metadata.created_at
        );
      }
      processedMeta++;
    } catch (error) {
      console.warn(`Failed to process metadata ${metadata.id}:`, error);
    }
  }

  console.log(`📊 Processed: ${processedMeta} metadata events`);

  // メッセージイベントの取得
  console.log("📥 Fetching channel messages...");
  const messageFilter: any = {
    kinds: [Kind.ChannelMessage],
    limit: 20000,
  };
  
  if (since) messageFilter.since = since;
  if (until) messageFilter.until = until;

  const messages = await pool.list(RELAYS, [messageFilter]);
  console.log(`Found ${messages.length} message events`);

  let processedMessages = 0;
  for (const message of messages) {
    try {
      // 期間チェック：指定期間外のデータはスキップ
      if (since && message.created_at < since) {
        continue;
      }
      if (until && message.created_at > until) {
        continue;
      }

      const root = message.tags.find((tag) => tag[0] === "e" && tag[3] === "root");
      if (!root) continue;

      const channelId = root[1];
      const channel = db.getChannel(channelId);
      if (!channel) continue;

      const msg: ChannelMessage = {
        id: message.id,
        channel_id: channelId,
        content: message.content,
        pubkey: message.pubkey,
        created_at: message.created_at,
      };
      
      db.insertMessage(msg);
      db.updateChannelLatestTime(channelId, message.created_at);
      processedMessages++;
    } catch (error) {
      console.warn(`Failed to process message ${message.id}:`, error);
    }
  }

  console.log(`📊 Processed: ${processedMessages} messages`);

  // 統計情報の表示
  const stats = db.getRefreshStats(since, until);
  console.log("\n📈 Refresh completed! Current database stats:");
  console.log(`- Channels: ${stats.channels.count}`);
  console.log(`- Messages: ${stats.messages.count}`);
  console.log(`- Meta history: ${stats.meta_history.count}`);
  
  if (since || until) {
    console.log(`- Period: ${stats.period.since || 'beginning'} to ${stats.period.until || 'now'}`);
  }

  console.log("\n✅ Refresh operation completed successfully!");
}

// 増分同期関数（新しいイベントのみ取得）
async function incrementalChannelUpdate() {
  const lastSync = db.getLastSyncTime();
  const currentTime = currUnixtime();
  
  console.log(`Incremental sync from ${lastSync} to ${currentTime}`);
  
  // 新しいチャンネル作成イベントのみ取得
  const newChannels = await pool.list(RELAYS, [
    {
      kinds: [Kind.ChannelCreation],
      since: lastSync,
    },
  ]);

  // 新しいチャンネルをDBに保存
  for (const channel of newChannels) {
    try {
      const parsedContent = JSON.parse(channel.content);
      const newChannel: Channel = {
        id: channel.id,
        author: channel.pubkey,
        name: parsedContent.name || "Untitled",
        content: channel.content,
        latest_update: channel.created_at,
        created_at: channel.created_at,
      };
      db.upsertChannel(newChannel);

      // メタデータ履歴にも保存
      const meta: ChannelMeta = {
        id: channel.id,
        channel_id: channel.id,
        kind: 40,
        content: channel.content,
        pubkey: channel.pubkey,
        created_at: channel.created_at,
      };
      db.insertChannelMeta(meta);
    } catch (error) {
      console.warn('Invalid JSON in channel content:', channel.content);
    }
  }

  // 新しいメタデータとメッセージを取得
  const newEvents = await pool.list(RELAYS, [
    {
      kinds: [Kind.ChannelMetadata, Kind.ChannelMessage],
      since: lastSync,
    },
  ]);

  // イベントを処理
  for (const ev of newEvents) {
    try {
      if (ev.kind === Kind.ChannelMetadata) {
        const root = ev.tags.find((tag) => tag[0] === "e");
        if (!root) continue;
        
        const channelId = root[1];
        const channel = db.getChannel(channelId);
        if (!channel || channel.author !== ev.pubkey) continue;

        const updateContent = JSON.parse(ev.content);
        const updatedChannel: Channel = {
          ...channel,
          name: updateContent.name || channel.name,
          content: ev.content,
          latest_update: Math.max(channel.latest_update, ev.created_at),
        };
        db.upsertChannel(updatedChannel);

        // メタデータ履歴に保存
        const meta: ChannelMeta = {
          id: ev.id,
          channel_id: channelId,
          kind: 41,
          content: ev.content,
          pubkey: ev.pubkey,
          created_at: ev.created_at,
        };
        db.insertChannelMeta(meta);
      }

      if (ev.kind === Kind.ChannelMessage) {
        const root = ev.tags.find((tag) => tag[0] === "e" && tag[3] === "root");
        if (!root) continue;

        const channelId = root[1];
        const channel = db.getChannel(channelId);
        if (!channel) continue;

        const message: ChannelMessage = {
          id: ev.id,
          channel_id: channelId,
          content: ev.content,
          pubkey: ev.pubkey,
          created_at: ev.created_at,
        };
        
        db.insertMessage(message);
        db.updateChannelLatestTime(channelId, ev.created_at);
      }
    } catch (error) {
      console.warn('Error processing event:', error);
    }
  }

  db.setLastSyncTime(currentTime);
  console.log(`Processed ${newChannels.length} new channels and ${newEvents.length} new events`);
}

// 完全同期関数（初回起動時のみ）


// 従来の完全同期（現在は非推奨、大きなデータセット用）
async function fullChannelUpdate() {
  console.log("⚠️  Starting FULL channel update (not recommended for large datasets)...");
  
  const recentChannels = await pool.list(RELAYS, [
    {
      kinds: [Kind.ChannelCreation],
      limit: 1000,
    },
  ]);

  const channelIds: string[] = [];
  for (const channel of recentChannels) {
    try {
    const parsedContent = JSON.parse(channel.content);
      const newChannel: Channel = {
      id: channel.id,
      author: channel.pubkey,
        name: parsedContent.name || "Untitled",
        content: channel.content,
      latest_update: channel.created_at,
        created_at: channel.created_at,
      };
      db.upsertChannel(newChannel);

      // メタデータ履歴にも保存（初回作成）
      const meta: ChannelMeta = {
        id: channel.id,
        channel_id: channel.id,
        kind: 40,
        content: channel.content,
        pubkey: channel.pubkey,
        created_at: channel.created_at,
      };
      db.insertChannelMeta(meta);

      channelIds.push(channel.id);
    } catch (error) {
      console.warn('Invalid JSON in channel content:', channel.content);
    }
  }

  // チャンクに分けてメタデータとメッセージを取得
  const chunkIds: string[][] = [];
  for (let i = 0; i < channelIds.length; i += 20) {
    chunkIds.push(channelIds.slice(i, i + 20));
  }

  for (const chunked of chunkIds) {
    // メタデータ取得
    const metadataFilter = chunked.map((id: string) => {
      const channel = db.getChannel(id);
      if (!channel) return null;
      return {
        kinds: [Kind.ChannelMetadata],
        "#e": [id],
        authors: [channel.author],
        limit: 10, // 履歴として複数取得
      };
    }).filter(Boolean);

    if (metadataFilter.length > 0) {
      const metadataResult = await pool.list(RELAYS, metadataFilter);
      
      for (const metadata of metadataResult) {
        try {
          const root = metadata.tags.find((tag) => tag[0] === "e");
          if (!root) continue;
          
          const channelId = root[1];
          const channel = db.getChannel(channelId);
          if (!channel || channel.author !== metadata.pubkey) continue;

          // メタデータ履歴に保存
          const meta: ChannelMeta = {
            id: metadata.id,
            channel_id: channelId,
            kind: 41,
            content: metadata.content,
            pubkey: metadata.pubkey,
            created_at: metadata.created_at,
          };
          db.insertChannelMeta(meta);

          // 最新のメタデータの場合、チャンネル情報を更新
          if (metadata.created_at > channel.created_at) {
        const updateContent = JSON.parse(metadata.content);
            db.updateChannelName(
              channelId,
              updateContent.name || channel.name,
              metadata.content,
              metadata.created_at
            );
          }
        } catch (error) {
          console.warn('Error processing metadata:', error);
        }
      }
    }

    // メッセージ取得
    const messageFilter = chunked.map((id: string) => ({
        kinds: [Kind.ChannelMessage],
        "#e": [id],
      limit: 10,
    }));

    const messageResult = await pool.list(RELAYS, messageFilter);
    
    for (const message of messageResult) {
      try {
        const root = message.tags.find((tag) => tag[0] === "e" && tag[3] === "root");
        if (!root) continue;

        const channelId = root[1];
        const channel = db.getChannel(channelId);
        if (!channel) continue;

        const msg: ChannelMessage = {
          id: message.id,
          channel_id: channelId,
          content: message.content,
          pubkey: message.pubkey,
          created_at: message.created_at,
        };
        
        db.insertMessage(msg);
        db.updateChannelLatestTime(channelId, message.created_at);
      } catch (error) {
        console.warn('Error processing message:', error);
      }
    }
  }

  console.log(`Full sync completed. Processed ${channelIds.length} channels.`);
}

const runServerMode = async (options: RefreshOptions = { mode: 'server' }) => {
  const api = new ChannelAPI(db, API_PORT);
  
  console.log("Channel Thread List System Starting...");
  console.log(`API Server: http://localhost:${API_PORT}`);
  
  // データベースに既存データがあるかチェック
  const existingChannels = db.getAllChannels(1);
  
  if (existingChannels.length === 0) {
    // 初回起動時は同期せず、APIサーバーのみ起動
    console.log("No existing data found. Starting API server without initial sync.");
    console.log("Use 'npm run refresh' to populate data manually.");
  } else {
    // 既存データがある場合は増分同期
    console.log("Existing data found. Performing incremental sync...");
    await incrementalChannelUpdate();
  }

  // 初回のnip78投稿
  debouncedNip78Update();
  console.log("Initial sync completed");

  console.log("Starting real-time subscription...");
  const sub = pool.sub(RELAYS, [
    { kinds: [40, 41, 42], since: currUnixtime() },
  ]);
  
  sub.on("event", (ev) => {
    try {
      if (ev.kind === 40) {
        const existChannel = db.getChannel(ev.id);
        if (existChannel) return;

        const content = JSON.parse(ev.content);
        const newChannel: Channel = {
          id: ev.id,
          author: ev.pubkey,
          name: content.name || "Untitled",
          content: ev.content,
          latest_update: ev.created_at,
          created_at: ev.created_at,
        };
        db.upsertChannel(newChannel);

        // メタデータ履歴に保存
        const meta: ChannelMeta = {
          id: ev.id,
          channel_id: ev.id,
          kind: 40,
          content: ev.content,
          pubkey: ev.pubkey,
          created_at: ev.created_at,
        };
        db.insertChannelMeta(meta);

        console.log(`New channel created: ${newChannel.name}`);
      }
      
      if (ev.kind === 41) {
        const root = ev.tags.find((tag) => tag[0] === "e");
        if (!root) return;

        const rootId = root[1];
        const channel = db.getChannel(rootId);
        if (!channel || channel.author !== ev.pubkey) return;

        const parsedContent = JSON.parse(ev.content);
        db.updateChannelName(
          rootId,
          parsedContent.name || channel.name,
          ev.content,
          Math.max(channel.latest_update, ev.created_at)
        );

        // メタデータ履歴に保存
        const meta: ChannelMeta = {
          id: ev.id,
          channel_id: rootId,
          kind: 41,
          content: ev.content,
          pubkey: ev.pubkey,
          created_at: ev.created_at,
        };
        db.insertChannelMeta(meta);

        console.log(`Channel metadata updated: ${parsedContent.name || channel.name}`);
      }
      
      if (ev.kind === 42) {
        const root = ev.tags.find((tag) => tag[0] === "e" && tag[3] === "root");
        if (!root) return;

        const rootId = root[1];
        const channel = db.getChannel(rootId);
        if (!channel) return;

        const message: ChannelMessage = {
          id: ev.id,
          channel_id: rootId,
          content: ev.content,
          pubkey: ev.pubkey,
          created_at: ev.created_at,
        };
        
        db.insertMessage(message);
        db.updateChannelLatestTime(rootId, ev.created_at);

        console.log(`New message in channel: ${channel.name}`);
      }
      
      // デバウンスされたnip78更新
      debouncedNip78Update();
    } catch (ex) {
      console.error('Error processing real-time event:', ex);
    }
  });

  // 古いメッセージクリーンアップ（8時間毎）
  cron.schedule("0 */8 * * *", async () => {
    console.log("Cleaning up old data...");
    db.cleanupOldMessages(30);
    db.cleanupOldMetaHistory(10);
  });

  // プロセス終了処理
cron.schedule("35 */8 * * *", async () => {
    console.log("Scheduled restart...");
    api.close();
    db.close();
    process.exit();
  });

  // プロセス終了時のクリーンアップ
  process.on('SIGINT', () => {
    console.log('Graceful shutdown...');
    api.close();
    db.close();
    process.exit();
  });

  process.on('SIGTERM', () => {
    console.log('Graceful shutdown...');
    api.close();
    db.close();
  process.exit();
});

  send("n-chan thread system with API server started.");
  console.log("System ready! 🚀");
};

// メイン実行部分
const main = async () => {
  try {
    // CLI引数の解析
    const options = parseCliArgs();
    
    // ヘルプ表示
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      printUsage();
      process.exit(0);
    }
    
    // バリデーション
    const errors = validateRefreshOptions(options);
    if (errors.length > 0) {
      console.error("❌ Validation errors:");
      errors.forEach(error => console.error(`  - ${error}`));
      printUsage();
      process.exit(1);
    }
    
    // モードに応じて処理を分岐
    if (options.mode === 'refresh') {
      await refreshChannelData(options);
      db.close();
      process.exit(0);
    } else {
      await runServerMode(options);
    }
  } catch (error) {
    console.error("❌ Fatal error:", error);
    db.close();
    process.exit(1);
  }
};

main();
