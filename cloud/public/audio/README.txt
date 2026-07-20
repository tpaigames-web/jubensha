目前所有剧本都【没有】背景音乐——试过一版环境音垫，三小时下来太吵，
还压主持人念白，已撤掉。主持人念白不受影响，照常工作。

要给某个剧本配乐的话：把 mp3 放在这个目录下，然后在该剧本的
skeleton.json 里声明：

  "audio": {
    "bgmLobby": "radio/lobby.mp3",
    "bgmByAct": { "act1": "radio/act1.mp3", "act2": "radio/act2.mp3" },
    "bgmDebrief": "radio/debrief.mp3"
  }

路径相对本目录。没声明或文件不存在时游戏静默运行，不会报错。
音量在 public/app.js 的 BGM.VOL（默认 0.16，刻意压得很低）。

想要现成素材，可以跑 tools/gen-audio.py 重新生成一套合成氛围垫
（需要 ffmpeg），生成的就是之前撤掉的那十首。
