import cron from "node-cron";

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

const send = async (content: string, targetEvent: Event | null = null) => {
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

const channelList = new Map<
  string,
  {
    id: string;
    author: string;
    latest_update: number;
    name: string;
    events: {
      content: string;
      pubkey: string;
      created_at: number;
    }[];
  }
>();

async function channelListUpdate() {
  const recentChannels = await pool.list(RELAYS, [
    {
      kinds: [Kind.ChannelCreation],
      limit: 1000,
    },
  ]);
  const ids = recentChannels.map((item) => item.id);
  const chunkIds: string[][] = [];
  for (let i = 0; i < ids.length; i += 20) {
    chunkIds.push(ids.slice(i, i + 20));
  }
  const channelMessages: Event<Kind>[] = [];
  for (const chunked of chunkIds) {
    const filter = chunked.map((id: string) => {
      return {
        kinds: [Kind.ChannelMessage],
        "#e": [id],
        limit: 3,
      };
    });
    const messages = await pool.list(RELAYS, filter);
    messages.map((item) => channelMessages.push(item));
  }

  for (const channel of recentChannels) {
    const channelDetail = channel.content
      ? JSON.parse(channel.content)
      : { name: "" };

    const messages = channelMessages
      .filter((message) => {
        const root = message.tags.find(
          (tag) => tag.includes("e") && tag.includes("root"),
        );
        return root ? channel.id === root[1] : false;
      })
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
    if (content.events.length > 0) {
      if (content.latest_update < content.events[0].created_at)
        content.latest_update = content.events[0].created_at;
    }
    channelList.set(channel.id, content);
  }
  return;
}

const main = async () => {
  console.log("init start");
  await channelListUpdate();
  const sortedChannelList = Array.from(channelList.values())
    .sort((a, b) => b.latest_update - a.latest_update)
    .slice(0, 50);
  nip78post("nchan_list", JSON.stringify(sortedChannelList));
  console.log("init ok");

  console.log("start sub");
  const sub = pool.sub(RELAYS, [
    { kinds: [40, 41, 42], since: currUnixtime() },
  ]);
  sub.on("event", (ev) => {
    try {
      if (ev.kind === 40) {
        const existChannel = channelList.get(ev.id);
        // channel がすでにあったら無視する
        if (existChannel) return;

        const content = JSON.parse(ev.content);
        const newChannel = {
          id: ev.id,
          author: ev.pubkey,
          latest_update: ev.created_at,
          name: content.name,
          events: [],
        };
        channelList.set(ev.id, newChannel);
      }
      if (ev.kind === 41) {
      }
      if (ev.kind === 42) {
        const root = ev.tags.find(
          (tag) => tag.includes("e") && tag.includes("root"),
        );
        // root の Channel id が取れなかったらぶち○す
        if (!root) return;

        const rootId = root[1];
        const channel = channelList.get(rootId);
        // channel がなかったらぶち○す
        if (!channel) return;

        const newEvent = {
          content: ev.content,
          pubkey: ev.pubkey,
          created_at: ev.created_at,
        };
        channel.events.push(newEvent);
        channel.events = channel.events
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, 3);
        channel.latest_update = newEvent.created_at;

        channelList.set(rootId, channel);
      }
      const sortedChannelList = Array.from(channelList.values())
        .sort((a, b) => b.latest_update - a.latest_update)
        .slice(0, 50);
      nip78post("nchan_list", JSON.stringify(sortedChannelList));
    } catch (ex) {
      console.error(ex);
    }
  });
};

cron.schedule("0 * * * *", async () => {
  await channelListUpdate();
  const sortedChannelList = Array.from(channelList.values())
    .sort((a, b) => b.latest_update - a.latest_update)
    .slice(0, 50);
  nip78post("nchan_list", JSON.stringify(sortedChannelList));
});

cron.schedule("35 */2 * * *", async () => {
  process.exit();
});

send("んちゃんねるThread更新システム起動");
main();
