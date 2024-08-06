import { currUnixtime } from "./utils.js";
import { finishEvent, Kind, SimplePool } from "nostr-tools";
import type { Event, EventTemplate } from "nostr-tools";
import dotenv from "dotenv";
import "websocket-polyfill";

dotenv.config();
const HEX: string = process.env.HEX ?? "";

const RELAYS = [
  "wss://relay-jp.nostr.wirednet.jp",
  "wss://r.kojira.io",
  "wss://yabu.me",
  "wss://relay-jp.shino3.net",
];

const pool = new SimplePool();

export const send = async (
  content: string,
  targetEvent: Event | null = null,
) => {
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

export const nip78post = async (storeName: string, content: string) => {
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

export async function getUpdatedChannels() {
  const recentChannels = await pool.list(RELAYS, [
    {
      kinds: [Kind.ChannelCreation],
      limit: 100,
    },
  ]);
  const recentMessages = await pool.list(RELAYS, [
    {
      kinds: [Kind.ChannelMessage],
      limit: 10000,
    },
  ]);
  const channelWithDetails: {
    [key: string]: {
      event: Event<Kind.ChannelCreation>;
      metadatas: Event<Kind.ChannelMetadata>[];
      messages: Event<Kind.ChannelMessage>[];
    };
  } = {};
  recentChannels.map((event) => {
    if (!channelWithDetails[event.id]) {
      channelWithDetails[event.id] = {
        event: {} as Event<Kind.ChannelCreation>,
        metadatas: [] as Event<Kind.ChannelMetadata>[],
        messages: [] as Event<Kind.ChannelMessage>[],
      };
    }
    Object.assign(channelWithDetails[event.id].event, event);
  });
  recentMessages.map((event) => {
    const root = event.tags.find(
      (tag) => tag.includes("e") && tag.includes("root"),
    );
    if (!root) return;
    const channelId = root[1];
    if (!channelWithDetails[channelId]) {
      channelWithDetails[channelId] = {
        event: null,
        metadatas: [] as Event<Kind.ChannelMetadata>[],
        messages: [] as Event<Kind.ChannelMessage>[],
      };
    }
    channelWithDetails[channelId].messages.push(event);
  });

  const withoutChannelIds = Object.keys(channelWithDetails).filter(
    (key) => channelWithDetails[key].event === null,
  );
  const withoutChannels = await pool.list(RELAYS, [
    {
      ids: withoutChannelIds,
    },
  ]);
  withoutChannels.map((event) => {
    channelWithDetails[event.id].event = {} as Event<Kind.ChannelCreation>;
    Object.assign(channelWithDetails[event.id].event, event);
  });
  const recentChannelMetas = await pool.list(RELAYS, [
    {
      kinds: [Kind.ChannelMetadata],
      limit: 1000,
    },
  ]);

  // チャンネル更新情報取得
  recentChannelMetas.map((event) => {
    const root = event.tags.find((tag) => tag[0] === "e");
    if (!root) return;
    const channelId = root[1];
    if (!channelWithDetails[channelId]) return;
    channelWithDetails[channelId].metadatas.push(event);
  });

  // 配列の最終加工
  const formattedChannelList: {
    id: string;
    author: string;
    latest_update: number;
    name: string;
    events: {
      content: string;
      pubkey: string;
      created_at: number;
    }[];
  }[] = [];
  Object.keys(channelWithDetails).map((key) => {
    const channel = channelWithDetails[key].event;

    // イベント情報がない場合は除外
    if (!channel) return;

    const channelDetail = channel.content
      ? JSON.parse(channel.content)
      : { name: "" };
    const messages = channelWithDetails[key].messages
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 3)
      .map((item) => {
        return {
          content: item.content,
          pubkey: item.pubkey,
          created_at: item.created_at,
        };
      });
    const content = {
      id: channel.id,
      author: channel.pubkey,
      latest_update: channel.created_at,
      name: channelDetail.name,
      events: messages,
    };
    const channelMeta = channelWithDetails[key].metadatas;
    if (channelMeta.length > 0) {
      const meta = channelMeta
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 1)
        .map((item) => {
          const parse = JSON.parse(item.content);
          return {
            name: parse.name,
            created: item.created_at,
          };
        });
      content.name = meta[0].name;
      content.latest_update = meta[0].created;
    }
    if (content.events.length > 0) {
      if (content.latest_update < content.events[0].created_at)
        content.latest_update = content.events[0].created_at;
    }
    formattedChannelList.push(content);
  });
  return formattedChannelList
    .sort((a, b) => b.latest_update - a.latest_update)
    .slice(0, 50);
}
