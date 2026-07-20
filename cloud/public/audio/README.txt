把背景音乐 mp3 放在这个目录下，然后在剧本的 skeleton.json 里声明：

  "audio": {
    "bgmLobby": "radio/lobby.mp3",
    "bgmByAct": { "act1": "radio/act1.mp3", "act2": "radio/act2.mp3" },
    "bgmDebrief": "radio/debrief.mp3"
  }

路径相对本目录。没声明或文件不存在时游戏静默运行，不会报错。
