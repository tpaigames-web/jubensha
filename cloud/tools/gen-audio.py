# -*- coding: utf-8 -*-
"""
合成剧本杀用的环境音垫（BGM）。

不是配乐，是「氛围垫」：低频持续音 + 雨声/气声，无旋律、无节拍，
用来垫住三个小时的沉默，不抢台词。全部由代码合成，无版权问题。

特点：
  - 无缝循环：所有振荡器频率锁到循环长度的整数倍；噪声层做首尾交叉淡化
  - 纯标准库合成 WAV，再用 ffmpeg 转 mp3（单声道 64k，一首约 500KB）

用法: python tools/gen-audio.py
输出: public/audio/<家族>/<名字>.mp3
"""
import math
import os
import random
import shutil
import subprocess
import sys
import wave
from array import array

SR = 22050          # 采样率：氛围垫没有高频细节，22k 足够，体积减半
LOOP = 60.0         # 循环长度（秒）
XF = 2.0            # 噪声层首尾交叉淡化长度（秒）
N = int(SR * LOOP)
NXF = int(SR * XF)

TAB = 4096
SINE = [math.sin(2 * math.pi * i / TAB) for i in range(TAB)]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "audio")


def add_osc(buf, freq, amp, phase=0.0, lfo_hz=0.0, lfo_depth=0.0):
    """把一个正弦叠加进 buf。频率与 LFO 都吸附到 1/LOOP 的整数倍，保证首尾相接。"""
    f = round(freq * LOOP) / LOOP
    step = f * TAB / SR
    idx = phase * TAB
    if lfo_hz > 0:
        lf = round(lfo_hz * LOOP) / LOOP
        lstep = lf * TAB / SR
        lidx = random.random() * TAB
        for i in range(N):
            a = amp * (1.0 - lfo_depth + lfo_depth * (0.5 + 0.5 * SINE[int(lidx) & (TAB - 1)]))
            buf[i] += a * SINE[int(idx) & (TAB - 1)]
            idx += step
            lidx += lstep
    else:
        for i in range(N):
            buf[i] += amp * SINE[int(idx) & (TAB - 1)]
            idx += step


def add_noise(buf, amp, cut, gust=0.35):
    """带通噪声：雨/气声。多生成 XF 秒，再把首尾交叉淡化成无缝循环。"""
    total = N + NXF
    lp1 = lp2 = hp = 0.0
    a = 1.0 - math.exp(-2.0 * math.pi * cut / SR)     # 一阶低通系数
    ha = 1.0 - math.exp(-2.0 * math.pi * 90.0 / SR)   # 去掉隆隆的次低频
    tmp = array("d", bytes(8 * total))
    for i in range(total):
        w = random.random() * 2.0 - 1.0
        lp1 += a * (w - lp1)
        lp2 += a * (lp1 - lp2)      # 两级低通，滚降更柔和
        hp += ha * (lp2 - hp)
        tmp[i] = lp2 - hp

    # 阵风：缓慢起伏，同样锁到循环长度
    g1 = round(0.037 * LOOP) / LOOP
    g2 = round(0.011 * LOOP) / LOOP
    s1 = g1 * TAB / SR
    s2 = g2 * TAB / SR
    i1 = i2 = 0.0

    for i in range(N):
        v = tmp[i]
        if i < NXF:                                   # 首尾交叉淡化
            t = i / NXF
            v = v * t + tmp[N + i] * (1.0 - t)
        env = 1.0 - gust + gust * (0.5 + 0.5 * SINE[int(i1) & (TAB - 1)]) \
                         * (0.5 + 0.5 * SINE[int(i2) & (TAB - 1)])
        buf[i] += amp * 3.2 * v * env
        i1 += s1
        i2 += s2


def add_pulse(buf, bpm, amp, freq=41.2):
    """心跳般的低频脉冲。每分钟拍数取能整除循环长度的值，避免接缝处断拍。"""
    beats = max(1, round(bpm * LOOP / 60.0))
    period = N / beats
    step = (round(freq * LOOP) / LOOP) * TAB / SR
    idx = 0.0
    for i in range(N):
        pos = (i % period) / period
        env = math.exp(-pos * 14.0) * (1.0 - math.exp(-pos * 220.0))
        buf[i] += amp * env * SINE[int(idx) & (TAB - 1)]
        idx += step


def render(spec):
    random.seed(spec["seed"])
    buf = array("d", bytes(8 * N))
    for freq, amp in spec["drone"]:
        add_osc(buf, freq, amp, phase=random.random(),
                lfo_hz=spec["swell_hz"], lfo_depth=spec["swell"])
    if spec.get("noise"):
        add_noise(buf, spec["noise"], spec["cut"], spec.get("gust", 0.35))
    if spec.get("pulse"):
        add_pulse(buf, spec["pulse"][0], spec["pulse"][1])

    peak = max(abs(v) for v in buf) or 1.0
    gain = 0.5 / peak                                  # 留 6dB 余量，念白时还要压低
    out = array("h", bytes(2 * N))
    for i in range(N):
        out[i] = int(max(-32000, min(32000, buf[i] * gain * 32767)))
    return out


def write_mp3(samples, path):
    tmp = path + ".wav"
    with wave.open(tmp, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(samples.tobytes())
    r = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", tmp,
         "-codec:a", "libmp3lame", "-b:a", "64k", "-ac", "1", path],
        capture_output=True, text=True,
    )
    os.remove(tmp)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg 失败: " + (r.stderr or "")[:400])


# 音高以 A1=55Hz 为根。小三度→压抑，小二度→不安，大三度→释然。
PRESETS = {
    # 《四十年》：南洋老店 · 雨夜
    "shop40/lobby":   dict(seed=11, drone=[(55, .16), (110, .10), (164.81, .05)],
                           noise=.055, cut=1100, swell=.35, swell_hz=.033),
    "shop40/act1":    dict(seed=12, drone=[(55, .17), (110, .10), (130.81, .06), (164.81, .05)],
                           noise=.070, cut=1400, swell=.40, swell_hz=.041),
    "shop40/act2":    dict(seed=13, drone=[(55, .18), (110, .09), (116.54, .06), (130.81, .05)],
                           noise=.085, cut=1800, gust=.5, swell=.50, swell_hz=.052),
    "shop40/act3":    dict(seed=14, drone=[(41.20, .20), (55, .12), (82.41, .07), (116.54, .05)],
                           noise=.075, cut=1600, gust=.5, swell=.50, swell_hz=.063,
                           pulse=(50, .13)),
    "shop40/debrief": dict(seed=15, drone=[(55, .16), (110, .10), (138.59, .07), (164.81, .06), (220, .03)],
                           noise=.035, cut=800, gust=.25, swell=.30, swell_hz=.027),

    # 通用悬疑垫：其它剧本可直接引用 common/*
    "common/lobby":   dict(seed=21, drone=[(58.27, .15), (116.54, .09), (174.61, .05)],
                           noise=.030, cut=900, swell=.35, swell_hz=.031),
    "common/act1":    dict(seed=22, drone=[(58.27, .17), (116.54, .09), (138.59, .06)],
                           noise=.040, cut=1200, swell=.40, swell_hz=.039),
    "common/act2":    dict(seed=23, drone=[(58.27, .18), (116.54, .08), (123.47, .06), (185.00, .04)],
                           noise=.050, cut=1600, gust=.45, swell=.50, swell_hz=.049),
    "common/act3":    dict(seed=24, drone=[(43.65, .20), (58.27, .12), (87.31, .07), (123.47, .05)],
                           noise=.050, cut=1500, gust=.5, swell=.50, swell_hz=.058,
                           pulse=(54, .13)),
    "common/debrief": dict(seed=25, drone=[(58.27, .16), (116.54, .10), (146.83, .07), (174.61, .05)],
                           noise=.025, cut=750, gust=.25, swell=.30, swell_hz=.025),
}


def main():
    if not shutil.which("ffmpeg"):
        sys.exit("找不到 ffmpeg，无法输出 mp3")
    for name, spec in PRESETS.items():
        path = os.path.join(OUT, *name.split("/")) + ".mp3"
        os.makedirs(os.path.dirname(path), exist_ok=True)
        write_mp3(render(spec), path)
        print("  %-18s %6.0f KB" % (name + ".mp3", os.path.getsize(path) / 1024))
    print("完成：%d 首 · 每首 %d 秒无缝循环" % (len(PRESETS), int(LOOP)))


if __name__ == "__main__":
    main()
