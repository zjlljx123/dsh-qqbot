#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-qqbot ASR 常驻服务：模型只加载一次，通过 stdin/stdout 行协议处理任务。

协议:
  请求(每行一个 JSON): {"path": "<音频绝对路径>", "lang": "zh"}
  响应(每行一个 JSON): {"ok": true, "text": "..."} 或 {"ok": false, "error": "..."}

启动: py -3 asr_server.py [--model small]
"""
import argparse
import json
import os
import sys

# stdout 统一 UTF-8 + 行缓冲，避免管道乱码/阻塞
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# 镜像/网络兼容
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

MODEL = None
MODEL_CACHE = os.environ.get("ASR_MODEL_DIR") or None


def pcm_to_wav(pcm_path, wav_path, sample_rate):
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
    ext = os.path.splitext(audio_path)[1].lower()
    out_wav = audio_path + ".wav"
    if ext == ".wav":
        return audio_path
    if ext in (".silk", ".amr"):
        try:
            import pilk
            pcm = audio_path + ".pcm"
            pilk.decode(audio_path, pcm, sample_rate)
            pcm_to_wav(pcm, out_wav, sample_rate)
            return out_wav
        except Exception:
            pass
    import shutil
    import subprocess
    ffmpeg = shutil.which("ffmpeg") or os.environ.get("FFMPEG_PATH", "ffmpeg")
    subprocess.run(
        [ffmpeg, "-y", "-i", audio_path, "-ar", str(sample_rate), "-ac", "1", out_wav],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return out_wav


def transcribe(audio_path, lang):
    global MODEL
    if MODEL is None:
        from faster_whisper import WhisperModel
        MODEL = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", download_root=MODEL_CACHE)
    wav = decode_to_wav(audio_path)
    segments, _info = MODEL.transcribe(
        wav,
        language=lang or "zh",
        beam_size=1,
        vad_filter=True,
        initial_prompt="以下是普通话的语音识别结果。",
    )
    return "".join(s.text for s in segments).strip()


def main():
    global MODEL_NAME
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=os.environ.get("ASR_MODEL", "small"))
    args = parser.parse_args()
    MODEL_NAME = args.model

    # 预热：启动即加载模型（后续任务秒回）
    try:
        _dummy = transcribe  # noqa - 保持引用
        from faster_whisper import WhisperModel
        MODEL = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", download_root=MODEL_CACHE)
        print(json.dumps({"ok": True, "ready": True}, ensure_ascii=False), flush=True)
    except Exception as e:
        print(json.dumps({"ok": False, "ready": False, "error": str(e)}, ensure_ascii=False), flush=True)
        sys.exit(1)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            path = req.get("path", "")
            lang = req.get("lang") or "zh"
            text = transcribe(path, lang)
            print(json.dumps({"ok": True, "text": text}, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
