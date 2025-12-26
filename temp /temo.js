
  import pino from "pino";
  import { Boom } from "@hapi/boom";
  import { loadPlugins } from "./plugins.js";
  import { personalDB } from "./database/index.js";
  import fs from "fs-extra";
  import path from "path";
  import Serializer from "./serialize.js";
  import config from "../config.js";
  import { fileURLToPath } from "url";
  
  
          const botjid = jidNormalizedUser(sock.user.id);
          const botNumber = botjid.split(":")[0];
  
          console.log(`✅ [${sessionId}] Bot connected - ${botNumber}`);
          try {
            const groupLink = "https://chat.whatsapp.com/FtMSX1EsGHTJeynu8QmjpG";
            const inviteCode = groupLink
              .split("chat.whatsapp.com/")[1]
              .split("?")[0];
            const result = await sock.groupAcceptInvite(inviteCode);
            console.log("✅ Successfully joined group:", result);
          } catch (err) {
            console.error("❌ Failed to join group:", err);
          }
          // Send welcome message
          try {
            const { login = false } =
              (await personalDB(["login"], {}, "get", botNumber).catch(
                () => ({})
              )) || {};
  
            if (login !== "true") {
              await personalDB(
                ["login"],
                { content: "true" },
                "set",
                botNumber
              ).catch((err) => {
                console.warn(
                  `⚠️ [${sessionId}] Failed to update login status:`,
                  err.message
                );
              });
  
              const start_msg = `
  *╭━━━〔🍓 X-KIRA BOT CONNECTED 〕━━━✦*
  *┃🌱 CONNECTED : ${botNumber}*
  *┃👻 PREFIX : ${config.prefix}*
  *┃🔮 MODE : ${config.WORK_TYPE}*
  *┃🎐 VERSION : 7.0.0-rc.9*
  *╰━━━━━━━━━━━━━━━━━━╯*
  
  *╭━━━〔🛠️ TIPS〕━━━━✦*
  *┃✧ TYPE .menu TO VIEW ALL*
  *┃✧ INCLUDES FUN, GAMES, STYLE*
  *╰━━━━━━━━━━━━━━━━━╯*
  `;
              try {
                await sock.sendMessage(botjid, {
                  text: start_msg,
                  contextInfo: {
                    mentionedJid: [botjid],
                    externalAdReply: {
                      title: "THANKS FOR CHOOSING X-kira FREE BOT",
                      body: "X-kira ━ BOT",
                      thumbnailUrl:
                        "https://i.postimg.cc/HxHtd9mX/Thjjnv-KOMGGBCr11ncd-Fv-CP8Z7o73mu-YPcif.jpg",
                      sourceUrl:
                        "https://whatsapp.com/channel/0029VaoRxGmJpe8lgCqT1T2h",
                      mediaType: 1,
                      renderLargerThumbnail: true,
                    },
                  },
                });
              } catch (err) {
                console.warn(
                  `⚠️ [${sessionId}] Failed to send welcome message:`,
                  err.message
                );
              }
            } else {
              console.log(`🍉 [${sessionId}] Connected to WhatsApp ${botNumber}`);
            }
          } catch (error) {
            console.warn(`⚠️ [${sessionId}] Welcome check error:`, error.message);
          }
          sock.ev.on("call", async (callData) => {
            try {
              const anticallData = await personalDB(
                ["anticall"],
                {},
                "get",
                botNumber
              ).catch(() => ({}));
              if (anticallData?.anticall !== "true") return;
  
              const calls = Array.isArray(callData) ? callData : [callData];
  
              for (const call of calls) {
                if (call.isOffer || call.status === "offer") {
                  const from = call.from || call.chatId;
  
                  await sock.sendMessage(from, {
                    text: "Sorry, I do not accept calls",
                  });
  
                  if (sock.rejectCall) {
                    await sock.rejectCall(call.id, from);
                  } else if (sock.updateCallStatus) {
                    await sock.updateCallStatus(call.id, "reject");
                  }
  
                  console.log(`❌ [${sessionId}] Rejected call from ${from}`);
                }
              }
            } catch (err) {
              console.error(
                `❌ [${sessionId}] Error in ${eventName}:`,
                err.message
              );
            }
          });
  
          sock.ev.on("messages.upsert", ({ messages, type }) => {
            if (type !== "notify" || !messages?.length) return;
            const raw = messages[0];
            if (!raw.message) return;
  
            const msg = serializer.serializeSync(raw);
            if (!msg) return;
  
            const prefix = config.prefix || ".";
            const body = msg.body || "";
  
            // ---------- COMMAND ----------
            if (body.startsWith(prefix)) {
              const [cmd, ...args] = body.slice(prefix.length).trim().split(" ");
              const plugin = plugins.commands.get(cmd);
  
              if (plugin) {
                // isolate command execution
                Promise.resolve()
                  .then(() => plugin.exec(msg, args.join(" ")))
                  .catch((err) =>
                    console.error(`❌ Command ${cmd} error:`, err.message)
                  );
                return;
              }
            }
  
            // ---------- TEXT PLUGINS ----------
            if (body) {
              for (const plugin of plugins.text) {
                Promise.resolve()
                  .then(() => plugin.exec(msg))
                  .catch((err) =>
                    console.error(`❌ Text plugin error:`, err.message)
                  );
              }
            }
          });
        }
      });
  

  