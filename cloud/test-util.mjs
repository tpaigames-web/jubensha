/**
 * 测试公共工具。
 *
 * 关键：房号只有 4 位（9000 个），而 Durable Object 的状态是永久保存的，
 * 跑过很多轮测试之后随机房号很容易撞上旧房间（里面还残留着上一局的席位与阶段），
 * 导致「新房间初始阶段为 lobby」这类断言莫名其妙地失败。
 * 所以测试必须先探测出一个真正空闲的房号再用。
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function probe(wsbase, code, script) {
  return new Promise((resolve) => {
    let done = false;
    const q = script ? `&script=${encodeURIComponent(script)}` : "";
    const ws = new WebSocket(`${wsbase}/ws?room=${code}${q}`);
    const finish = (free) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      resolve(free);
    };
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "hello") finish(m.room.seatsTaken === 0 && m.room.phase === "lobby");
    });
    ws.addEventListener("error", () => finish(false));
    setTimeout(() => finish(false), 8000);
  });
}

/** 找一个确实空闲的房号（没人入座且仍在 lobby） */
export async function findFreeRoom(wsbase, script = null, tries = 25) {
  for (let i = 0; i < tries; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (await probe(wsbase, code, script)) return code;
    await wait(120);
  }
  throw new Error("找不到空闲房号，请清理测试残留或扩大房号空间");
}
