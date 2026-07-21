# 剧本杀小馆 · 新引擎

无主持人的剧本杀运行时。所有 DM 职能（分幕推进、线索分发、权限裁决、计时、播报、复盘）由程序承担。

**线上地址**：https://jubensha.tpaigames.workers.dev

- 运行在 Cloudflare Workers + Durable Objects：一个房间 = 一个 DO 实例，状态强一致、进程回收不丢局
- 电脑不用开机；购买的商业本因版权只留在本地 Python 服务器（`../server.py`），不上云

## 现有剧本

| id | 人数 | 时长 | 类型 |
|---|---|---|---|
| `lighthouse` 孤岛灯塔 | 3 人 | ~65 分钟 | 指认凶手 · 暴风孤岛 |
| `temple` 雪夜山神庙 | 3 人 | ~65 分钟 | 指认凶手 · 古风雪夜 |
| `typhoon` 台风夜 | 3 人 | ~110 分钟 | 悬疑还原 · 三人三对，每对都有第三人不知道的秘密 |
| `gallery` 午夜美术馆 | 4 人 | ~65 分钟 | 指认凶手 · 赝品与遗嘱 |
| `inn` 雾隐客栈 | 4 人 | ~65 分钟 | 指认凶手 · 古风雪夜 |
| `party` 寿宴上的窃案 | 4 人 | ~65 分钟 | **欢乐新手本** · 无人死亡 |
| `shop40` 四十年老店的最后一夜 | 4 人 | ~180 分钟 | 情感还原 · 八格时间线拼图 · 家庭向 |
| `radio` 午夜电台 | 5 人 | ~65 分钟 | 指认凶手 · 硬核时间诡计 |
| `xianmen` 宗门大比前夜 | 5 人 | ~65 分钟 | **欢乐修仙本** · 无人死亡 |
| `huihun` 回魂夜 | 6 人 | ~65 分钟 | 指认凶手 · 民国灵异 |
| `oldshop` 四十年 | 4 人 | ~160 分钟 | **已退役**：与 `shop40` 是同一个设定，两本并排让人分不出来 |
| `placeholder` / `fasttest` | — | — | 测试夹具，不对玩家展示 |

`meta.draft: true` 的剧本不进选本列表、也不能被 `/api/newroom` 开局，但仍可用
`/ws?room=XXXX&script=<id>` 直连自测，已有房间也照常能玩。想让退役的本重新上架，
把生成器里那一行 `draft: true` 删掉重新生成即可。

正文所在处（**玩家不要读**）：
`shop40` → `content/`（密封，见 SPOILER-WARNING.md）　
`typhoon` → `tools/build-typhoon.mjs`　
`oldshop` → `tools/build-oldshop.mjs`

---

## 加一个新剧本（不用改任何源码）

1. 在 `scripts/` 下新建文件夹，名字就是剧本 id（英文小写），放两个文件：

   ```
   scripts/<剧本id>/
     skeleton.json    结构骨架：幕、线索 id、可见性规则、机制参数。只有 key，无正文
     content.pack     文案包：key → 正文
   ```

2. 跑两条命令：

   ```bash
   node tools/validate.mjs <剧本id>   # 先校验，有问题当场报错
   node tools/register.mjs            # 扫描 scripts/ 重新生成注册表
   npx wrangler deploy                # 部署
   ```

剧本就会自动出现在选本列表里。引擎不认识正文，只认 key。

### 从旧格式转换

旧版单文件剧本（`../scripts/*.json`）可以一条命令转过来：

```bash
node tools/convert.mjs "C:\sohai\jubensha\scripts\xxx.json" <新剧本id>
```

转换器会自动补上玩法说明、把 `goals`/`secrets` 渲染成【你今晚要做到的】【你不能让人知道的】、
按票数比例生成全票/多数决/平局分支、把 `truth` 拆成逐段复盘。

**但角色之间的关系写不出来**——没有关系，一屋子人就不知道该跟谁说话。
这部分放在增补层 `tools/enrich/<剧本id>.mjs`，有就用，没有就退回「你只知道他自称是谁」
（对荒岛/客栈这种萍水相逢的设定，这反而是对的）：

```js
export default {
  opening: "…可选：第一幕开场播报的引子…",
  roles: {
    <角色id>: {
      story: "…可选：覆盖原始角色本…",
      rel: { <另一角色id>: "在这个角色眼里，对方是什么人" },
      act2: "…第二幕这个人的处境…",
      actLast: "…最后一幕…",
    },
  },
};
```

### 投票结算的分支

`resultBranches` 的 `match` 只认三种写法，按优先级匹配：

| 写法 | 命中条件 |
|---|---|
| `unanimous_<选项id>` | 全票投给同一个选项 |
| `majority_<选项id>` | 严格多数（过半且无并列第一）——3 人的 2:1、5 人的 3:2 |
| `split` | 其余情况，**必须写**，是兜底 |

选项超过两个却不写 `majority_*`，几乎每一局都会落到同一个 `split` 结尾——校验器会警告。

### 校验器会查什么

角色数与 `meta.players` 是否一致、每幕是否给齐所有角色的剧本 key、线索是否指向存在的幕、
私有线索的角色是否存在、投票分支名是否拼错或指向不存在的选项、是否有兜底 `split`、
机制声明是否有对应参数、**文案包是否缺 key**、地点是否有线索（避免玩家点了搜不到东西）、
线索数是否够全场搜。

---

## 背景音乐（默认没有）

**所有剧本目前都不放背景音乐。** 试过一版合成氛围垫，三小时下来太吵、还压念白，已撤掉。
主持人念白不受影响。

要给某个剧本配乐，把文件放 `public/audio/<剧本id>/`，再在 `skeleton.json` 里声明：

```json
"audio": {
  "bgmLobby": "radio/lobby.mp3",
  "bgmByAct": { "act1": "radio/act1.mp3", "act2": "radio/act2.mp3" },
  "bgmDebrief": "radio/debrief.mp3"
}
```

幕切换时交叉淡入淡出，主持人念白时自动压低。**没声明或文件不存在时静默跳过，不会报错。**
音量在 `public/app.js` 的 `BGM.VOL`（默认 0.16，刻意压得很低）。
循环走 Web Audio 而不是 `<audio loop>`——后者每转一圈会漏出 mp3 的编码填充，
垫在持续低音上是很明显的一声断裂。

需要现成素材的话，`python tools/gen-audio.py`（要 ffmpeg）能合成一套无版权的氛围垫，
生成的就是之前撤掉的那十首。

念白目前用浏览器内建 TTS；换成录音文件的话在 `public/app.js` 的 `speak()` 里替换即可。

---

## 本地开发与测试

```bash
npm install
npx wrangler dev --port 8788          # 终端 A：本地服务器

node test-prod.mjs                     # 终端 B：传输层冒烟
node test-seat.mjs                     # 身份与恢复
node test-engine.mjs                   # 可见性与运行时引擎
node test-timer.mjs                    # DO Alarm 计时链路
node test-chat.mjs                     # 阅读推进与聊天权限
node test-oldshop.mjs                  # 已退役的《四十年》整局（顺带验证下架没把它弄坏）
node test-typhoon.mjs                  # 《台风夜》整局 + 多数决结算
node test-shop40-shape.mjs             # shop40 结构验收（验引擎与可见性，不验剧情）
node test-all-scripts.mjs              # 全剧本冒烟：每个本都从入座跑到结束
node test-clue.mjs                     # 搜证私藏与主动公开
# 每条后面加 https://jubensha.tpaigames.workers.dev 即可打生产
```

### 一个人测完整局

开一局后记下房号，用陪练机器人补满其余席位：

```bash
node bots.mjs <房号> <机器人数量> https://jubensha.tpaigames.workers.dev
```

机器人会自动选角、读本、搜证、投票、拼图、推进复盘。
（4人本开 3 个，5人本开 4 个。）

---

## 防剧透规约

- `content.pack` / `*.content.json` / `script_full.*` 是剧本正文，**禁止读取、解码、打印、写日志或在对话中展示**
- 引擎全程只处理 key 与 id；正文只在服务端确认「该席位此刻有权查看」之后、下发的那一瞬间才解析（见 `src/visibility.ts` 的 `entitledKeys`）
- 文案包打进 Worker 包体，**不放 public/**，因此无法被公开下载

## 目录

```
src/
  index.ts          Worker 入口：房号 → DO 路由、静态资源、剧本列表接口
  room.ts           RoomDO：席位、状态机、计时、播报、搜证、投票、聊天、复盘
  visibility.ts     服务端权威可见性裁决（防剧透总闸）
  content.ts        文案解析层（只在下发瞬间解析）
  skeleton.ts       骨架类型与注册表
  registry.gen.ts   自动生成，勿手改
  mechanics/        可插拔机制组件（validator 四接口）
public/             前端（原生 JS，无构建步骤）
scripts/            剧本包
tools/              convert / register / validate
```
