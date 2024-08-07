import {
  nip78post,
  send,
  getUpdatedChannels,
  getUpdatedChannelsV2,
} from "./Nostr.js";
import cron from "node-cron";

const main = async () => {
  // const result = await getUpdatedChannels();
  const result = await getUpdatedChannelsV2();
  await nip78post("nchan_list", JSON.stringify(result));
  // console.log(JSON.stringify(result));
  console.log("exit");
};

cron.schedule("*/5 * * * *", async () => {
  main();
});

send("んちゃんねるThread更新システム起動");
main();
