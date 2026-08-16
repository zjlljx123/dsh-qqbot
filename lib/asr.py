#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-qqbot ASR helper:
  - QQ 语音(silk) -> wav  (pilk 解码, 16kHz)
  - wav/其他音频  -> 文字 (faster-whisper 本地识别, 中文优先)

用法:
  py -3 asr.py <input.silk|input.wav|input.mp3> [--model small] [--lang zh]

输出: 识别文本打印到 stdout。
"""
import argparse
import os
import sys

# stdout 统一用 UTF-8，避免 Windows 下 GBK 输出导致 Node 侧乱码
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 镜像/网络兼容：禁用 xet 协议，走传统 HTTPS 下载（hf-mirror 等镜像必需）
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
# 可选镜像加速: 设 HF_ENDPOINT=https://hf-mirror.com

MODEL_CACHE = os.environ.get("ASR_MODEL_DIR") or None  # 可选: 本地模型目录


def pcm_to_wav(pcm_path, wav_path, sample_rate):
    """16bit 单声道 PCM 加 WAV 头。"""
    import struct
    with open(pcm_path, "rb") as f:
        data = f.read()
    with open(wav_path, "wb") as f:
        f.write(b"RIFF")
        f.write(struct.pack("<I", 36 + len(data)))
        f.write(b"WAVEfmt ")
        f.write(struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16))
        f.write(b"data")
        f.write(struct.pack("<I", len(data)))
        f.write(data)


def decode_to_wav(audio_path, sample_rate=16000):
    """把 QQ 语音(amr/silk 等)转成 16k wav，返回 wav 路径。

    QQ/NapCat 的 .amr 文件实际多是 silk 编码（伪 amr），
    先用 pilk(silk 解码) 处理，失败再退回 ffmpeg。
    """
    ext = os.path.splitext(audio_path)[1].lower()
    out_wav = audio_path + ".wav"
    if ext == ".wav":
        return audio_path
    if ext in (".silk", ".amr"):
        try:
            import pilk
            pcm = audio_path + ".pcm"
            pilk.decode(audio_path, pcm, sample_rate)  # 位置参数: (silk, pcm, rate)
            pcm_to_wav(pcm, out_wav, sample_rate)
            return out_wav
        except Exception as e:
            # 不是真 silk，继续走 ffmpeg
            pass
    # amr(真) / mp3 / m4a / ogg ... -> ffmpeg 转 16k 单声道 wav
    import shutil
    import subprocess
    ffmpeg = shutil.which("ffmpeg") or os.environ.get("FFMPEG_PATH", "ffmpeg")
    subprocess.run(
        [ffmpeg, "-y", "-i", audio_path, "-ar", str(sample_rate), "-ac", "1", out_wav],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return out_wav


def transcribe(audio_path, model_name, lang):
    from faster_whisper import WhisperModel

    # 支持 HF 镜像: 设置 HF_ENDPOINT=https://hf-mirror.com 可加速模型下载
    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",
        download_root=MODEL_CACHE,
    )
    segments, _info = model.transcribe(
        audio_path,
        language=lang,
        beam_size=1,
        vad_filter=True,
        initial_prompt="以下是普通话的语音识别结果。",
    )
    text = "".join(s.text for s in segments).strip()
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="silk / wav / mp3 音频路径")
    parser.add_argument("--model", default=os.environ.get("ASR_MODEL", "small"))
    parser.add_argument("--lang", default="zh")
    args = parser.parse_args()

    inp = args.input
    if not os.path.exists(inp):
        print("[asr] 输入文件不存在", file=sys.stderr)
        sys.exit(2)

    ext = os.path.splitext(inp)[1].lower()
    try:
        wav = decode_to_wav(inp)
    except Exception as e:
        print(f"[asr] 音频解码失败({ext}): {e}", file=sys.stderr)
        sys.exit(3)

    try:
        text = transcribe(wav, args.model, args.lang)
        print(text)
    except Exception as e:
        print(f"[asr] 识别失败: {e}", file=sys.stderr)
        sys.exit(4)


if __name__ == "__main__":
    main()
