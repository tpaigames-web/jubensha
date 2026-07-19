/**
 * 阶段 1 验收测试：Seat 身份模型
 * 对照《改造实施说明书》第 11 章「身份与恢复」清单逐条验证。
 * 用法：node test-seat.mjs [baseUrl]
 */
const HTTP = process.argv[2] || "http://127.0.0.1:8788";
const WSBASE = HTTP.replace(/^http/, "ws");

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); c ? pass++ : (fail++, process.exitCode = 1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 记录所有连接，结束时统一关闭，否则 Node 事件循环不会退出 */
const ALL = [];

function conn(room) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${WSBASE}/ws?room=${room}`);
    ALL.push(ws);
    const msgs = [];
    ws.addEventListener("message", (e) => msgs.push(JSON.parse(e.data)));
    ws.addEventListener("open", () => res({
      ws, msgs,
      send: (o) => ws.send(JSON.stringify(o)),
      last: (t) => [...msgs].reverse().find((m) => m.type === t),
      clear: () => (msgs.length = 0),
    }));
    ws.addEventListener("error", rej);
    setTimeout(() => rej(new Error("timeout")), 10000);
  });
}

const ROOM = String(Math.floor(1000 + Math.random() * 9000));
console.log("测试房号:", ROOM, "| 目标:", HTTP, "\n");

// ---- 1. 四人完整入场 ----
console.log("【1】四人入场");
const players = [];
for (const [name, pin] of [["爸爸", "1111"], ["妈妈", "2222"], ["哥哥", "3333"], ["妹妹", "4444"]]) {
  const c = await conn(ROOM);
  await wait(200);
  c.send({ type: "seat.claim", displayName: name, pin });
  await wait(300);
  const snap = c.last("snapshot.full");
  ok(!!snap, `${name} 认领席位成功`);
  ok(!!snap?.seatToken, `${name} 收到专属令牌（仅此一次）`);
  players.push({ name, pin, c, seatId: snap.me.seatId, token: snap.seatToken });
}
ok(new Set(players.map((p) => p.seatId)).size === 4, "四人分到四个不同席位");
ok(players[3].c.last("snapshot.full").seats.length === 4, "名册显示4人");

// ---- 2. 满员 / 重名 / 边界 ----
console.log("\n【2】边界拒绝");
const extra = await conn(ROOM);
await wait(200);
extra.send({ type: "seat.claim", displayName: "多余的人", pin: "5555" });
await wait(300);
ok(extra.last("error")?.code === "room_full", "第5人被拒（房间已满）");

const dupRoom = String(Math.floor(1000 + Math.random() * 9000));
const d1 = await conn(dupRoom); await wait(200);
d1.send({ type: "seat.claim", displayName: "同名", pin: "1234" }); await wait(300);
const d2 = await conn(dupRoom); await wait(200);
d2.send({ type: "seat.claim", displayName: "同名", pin: "9999" }); await wait(300);
ok(d2.last("error")?.code === "name_taken", "重名被拒");
d2.send({ type: "seat.claim", displayName: "小明", pin: "12" }); await wait(300);
ok(d2.last("error")?.code === "bad_input", "非4位PIN被拒");

// ---- 3. 换浏览器：用专属令牌恢复 ----
console.log("\n【3】换设备恢复（令牌）");
const dad = players[0];
dad.c.ws.close();
await wait(500);
const dadNew = await conn(ROOM);
await wait(200);
dadNew.send({ type: "seat.resume", seatToken: dad.token });
await wait(300);
const rs = dadNew.last("snapshot.full");
ok(rs?.me?.seatId === dad.seatId, "关标签页后用专属令牌在新连接恢复到同一席位");
ok(rs?.me?.displayName === "爸爸", "恢复后身份正确: " + rs?.me?.displayName);
ok(!rs?.seatToken, "恢复时不再重复下发令牌");
dad.c = dadNew;

// ---- 4. 清空 localStorage：房号+昵称+PIN 兜底 ----
console.log("\n【4】兜底恢复（昵称+PIN）");
const mom = players[1];
mom.c.ws.close();
await wait(500);
const momNew = await conn(ROOM);
await wait(200);
momNew.send({ type: "seat.recover", displayName: "妈妈", pin: "2222" });
await wait(300);
ok(momNew.last("snapshot.full")?.me?.seatId === mom.seatId, "清空存储后用 昵称+PIN 恢复成功");

const bad = await conn(ROOM); await wait(200);
bad.send({ type: "seat.recover", displayName: "妈妈", pin: "0000" }); await wait(300);
ok(bad.last("error")?.code === "bad_pin", "错误PIN被拒");
bad.send({ type: "seat.resume", seatToken: "伪造的令牌" }); await wait(300);
ok(bad.last("error")?.code === "bad_token", "伪造令牌被拒");
bad.ws.close();
mom.c = momNew;

// ---- 5. 同席位多设备并存 + 互斥提示 ----
console.log("\n【5】席位互斥提示");
const bro = players[2];
bro.c.clear();
const broPad = await conn(ROOM);
await wait(200);
broPad.send({ type: "seat.resume", seatToken: bro.token });
await wait(400);
ok(!!bro.c.last("seat.elsewhere"), "旧设备收到「席位已在其他设备打开」提示");
ok(!!broPad.last("snapshot.full"), "新设备正常入座");

// 两端都还能操作，且广播按 seatId 路由到该席位全部连接
bro.c.clear(); broPad.clear();
broPad.send({ type: "read.progress", progress: 0.5 });
await wait(400);
ok(bro.c.last("snapshot.full")?.me?.readProgress === 0.5, "旧设备也收到本席位状态更新（按seatId广播）");
ok(broPad.last("snapshot.full")?.me?.readProgress === 0.5, "新设备状态正确");
bro.c.send({ type: "read.progress", progress: 0.8 });
await wait(400);
ok(broPad.last("snapshot.full")?.me?.readProgress === 0.8, "旧设备仍可正常操作（不强制踢线）");

// ---- 6. 无房主依赖 ----
console.log("\n【6】无房主概念");
const creator = players[0]; // 第一个入场的人
creator.c.ws.close();
await wait(600);
const sis = players[3];
sis.clear?.();
sis.c.send({ type: "act.ready" });
await wait(400);
ok(sis.c.last("snapshot.full")?.me?.ready === true, "创建房间的人退出后，其余玩家仍可正常操作");
const names = sis.c.last("snapshot.full").seats.map((s) => s.displayName);
ok(names.length === 4, "席位仍完整保留（离线≠退座）: " + names.join(","));
const dadSeat = sis.c.last("snapshot.full").seats.find((s) => s.displayName === "爸爸");
ok(dadSeat?.online === false, "离线席位标记为 offline，位置仍占着");

// ---- 7. 持久化：全员断开后重连 ----
console.log("\n【7】持久化");
for (const p of players) { try { p.c.ws.close(); } catch {} }
try { broPad.ws.close(); } catch {}
await wait(1500);
const back = await conn(ROOM);
await wait(200);
back.send({ type: "seat.resume", seatToken: players[3].token });
await wait(400);
const bs = back.last("snapshot.full");
ok(bs?.me?.displayName === "妹妹", "全员断开后重连，席位与身份存活");
ok(bs?.me?.ready === true, "席位私有状态(ready)一并存活");
ok(bs?.seats?.length === 4, "四个席位全部存活");
console.log(`\n=== 阶段1 验收：${pass} 通过 / ${fail} 失败 ===`);

for (const ws of ALL) { try { ws.close(); } catch {} }
await wait(300);
process.exit(fail ? 1 : 0);
