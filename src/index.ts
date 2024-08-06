import { nip78post, send, getUpdatedChannels } from "./Nostr.js";
import cron from "node-cron";

const main = async () => {
  const result = await getUpdatedChannels();
  JSON.stringify(result);
  await nip78post("nchan_list", JSON.stringify(result));
  console.log("exit");
};

cron.schedule("*/5 * * * *", async () => {
  main();
});

send("んちゃんねるThread更新システム起動");
main();
