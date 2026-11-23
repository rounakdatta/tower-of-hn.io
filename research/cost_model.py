#!/usr/bin/env python3
"""TowerOfHan.io monthly cost model (companion to data-infra.md; prices and sources are listed there).

usage: python3 -I cost_model.py [--gpu-hours-day 5] [--comments-day 12000] [--kbps 24] [--hours-day 24]
Everything is a parameter; unit prices are the constants below (USD, read 19 Nov 2026).
"""
import argparse, math

# ---- unit prices (USD) ----
EUR_USD = 1.0968                               # ECB reference rate 2026-11-18 (api.frankfurter.dev)
CF = dict(base=5.0, w_req=0.30, w_req_free=10e6, w_cpu_ms=0.02 / 1e6, w_cpu_free=30e6,
          r2_gb=0.015, r2_a=4.50 / 1e6, r2_a_free=1e6, r2_b=0.36 / 1e6, r2_b_free=10e6, r2_free_gb=10,
          do_req=0.15 / 1e6, do_req_free=1e6, do_gbs=12.5 / 1e6, do_gbs_free=400e3, q_op=0.40 / 1e6, q_free=1e6)
HOURS_MONTH = 720
TTS = dict(modal_l4_h=0.7992, modal_cpu_core_s=0.0000131, modal_ram_gib_s=0.00000222,   # modal.com/pricing
           cf_vcpu_s=0.000020, gex45_eur=214.0, gex45_setup_eur=209.0, ax42_eur=79.0, ax42_setup_eur=49.0,
           runpod_comm_4090_h=0.34, aura1_per_1k=0.015, eleven_per_1k=0.12)
LLM = {  # name: (in $/M, out $/M); first-party list prices, thinking off
    "Qwen3.7-Flash (Alibaba SG)": (0.03, 0.13), "Haiku 5.5": (0.10, 0.50), "GPT-6 Luna": (0.10, 0.50),
    "Workers AI Qwen3-30B-A3B": (0.051, 0.335), "Gemini 3.5 Flash-Lite": (0.30, 2.50),
    "DeepSeek V4.1 Flash (off-peak)": (0.15, 0.60), "Haiku 4.5": (1.00, 5.00)}
DAYS = 30


def pipeline(a):
    chars = a.comments_day * a.chars
    audio_h_day = chars / a.cps / 3600
    clip_s = a.chars / a.cps
    bytes_comment = clip_s * a.kbps * 1000 / 8 + a.curve_bytes
    return dict(chars_day=chars, audio_h_day=audio_h_day, clip_s=clip_s, bytes_comment=bytes_comment,
                gb_month_new=a.comments_day * DAYS * bytes_comment / 1e9)


def cf_storage(gb_month_new, months):
    gb = gb_month_new * months
    return max(0, gb - CF["r2_free_gb"]) * CF["r2_gb"]


def live_update(C, H, a, mech):
    vh = C * H * DAYS                      # viewer-hours / month
    sessions = vh * 60 / a.session_min     # connections / month
    events = a.comments_day * DAYS
    shards = max(1, math.ceil(C / a.sockets_per_do))
    if mech == "poll":                     # CDN-cached head.json, no Worker on the path
        reqs = vh * 3600 / a.poll_s
        refills = a.upper_tiers * (DAYS * 86400 / a.ttl_s)
        r2b = max(0, refills - CF["r2_b_free"]) * CF["r2_b"]
        return r2b, reqs
    if mech == "ws":                       # DO WebSocket hibernation, server->client only, auto-response pings
        w = max(0, sessions - CF["w_req_free"]) * CF["w_req"] / 1e6
        cpu = max(0, sessions * a.ws_cpu_ms - CF["w_cpu_free"]) * CF["w_cpu_ms"]
        do_req = max(0, sessions + shards * events - CF["do_req_free"]) * CF["do_req"]
        dur = max(0, shards * events * a.fanout_s * 0.125 - CF["do_gbs_free"]) * CF["do_gbs"]
        return w + cpu + do_req + dur, sessions
    if mech == "sse":                      # Worker per client + streaming from DO shards (no hibernation)
        w = max(0, sessions - CF["w_req_free"]) * CF["w_req"] / 1e6
        cpu = max(0, sessions * a.sse_cpu_ms - CF["w_cpu_free"]) * CF["w_cpu_ms"]
        do_req = max(0, sessions - CF["do_req_free"]) * CF["do_req"]
        dur = max(0, shards * 0.125 * DAYS * 86400 * H / 24 - CF["do_gbs_free"]) * CF["do_gbs"]
        return w + cpu + do_req + dur, sessions


def egress(C, H, a):
    vh = C * H * DAYS
    return vh * 3600 * a.kbps * 1000 / 8 * 1.05 / 1e12      # TB, +5% container/HTTP overhead


def bunny(tb):                              # Volume Network: $0.005/GB first 500 TB, $0.004 to 1 PB, $0.002 to 2 PB
    t = tb * 1000
    cost, tiers = 0.0, [(500e3, 0.005), (500e3, 0.004), (1000e3, 0.002)]
    for size, p in tiers:
        take = min(t, size); cost += take * p; t -= take
    return cost


def r2_miss_cost(C, H, a):
    audio_reqs = C * H * DAYS * 3600 / (a.chars / a.cps)
    reads = audio_reqs * a.miss_rate
    return max(0, reads - CF['r2_b_free']) * CF['r2_b'], audio_reqs


def llm_month(a, name):
    pin, pout = LLM[name]
    n = a.comments_day * DAYS
    return n * a.tok_in * pin / 1e6 + n * a.tok_out * pout / 1e6


def tts_table(a, d):
    audio_s_month = d["audio_h_day"] * 3600 * DAYS
    print(f"\nTTS compute, $/month (audio produced: {d['audio_h_day']:.1f} h/day = {audio_s_month/3600:,.0f} h/month)")
    print("| Option | 1 busy GPU-h/day | 5 | 15 | note |")
    print("|---|---|---|---|---|")
    ticks = 86400 / 34                                   # HN delivers in ~34 s batches
    def micro(g, window_s, cold_s=15, idle_s=60):         # micro-batch every window_s, container scales down after idle_s
        runs = 86400 / window_s
        busy_per_run = g * 3600 / runs
        return runs * (busy_per_run + cold_s + idle_s) * TTS["modal_l4_h"] / 3600 * DAYS
    row = lambda name, f, note: print(f"| {name} | " + " | ".join(f"${f(g):,.0f}" for g in (1, 5, 15)) + f" | {note} |")
    row("Serverless per-second, busy time only (ideal, not achievable in real time)", lambda g: g * DAYS * TTS["modal_l4_h"], "Modal L4 $0.7992/h")
    row("Serverless, real time: container stays warm (60 s window, arrivals every 7 s)", lambda g: HOURS_MONTH * TTS["modal_l4_h"], "GPU only; CPU/RAM add about $0.08/h")
    row("Serverless, micro-batch every 5 min, 15 s cold start, 60 s idle window", lambda g: micro(g, 300), "adds 2.5 min mean wait")
    row("Serverless, micro-batch every 5 min, 15 s cold start, 2 s idle window", lambda g: micro(g, 300, idle_s=2), "adds 2.5 min mean wait")
    row("Hetzner GEX45 24x7 (EUR 214; setup EUR 209 not included)", lambda g: TTS["gex45_eur"] * EUR_USD, "dedicated, Helsinki; setup = $229 once")
    row("RunPod Community RTX 4090 pod 24x7 ($0.34/h)", lambda g: HOURS_MONTH * TTS["runpod_comm_4090_h"], "stock-limited; UNVERIFIED reliability")
    row("Hetzner AX42 CPU box 24x7 (EUR 79; setup EUR 49)", lambda g: TTS["ax42_eur"] * EUR_USD, "only if a CPU model is fast enough (see below)")
    print("\nBreak-even busy GPU-h/day, serverless (busy-only) vs flat: GEX45 = %.1f h/day; RunPod community 4090 = %.1f h/day" % (
        TTS["gex45_eur"] * EUR_USD / DAYS / TTS["modal_l4_h"], HOURS_MONTH * TTS["runpod_comm_4090_h"] / DAYS / TTS["modal_l4_h"]))
    print("\nCPU TTS, pay-per-use, $/month for the same audio (RTF measured on 4 vCPU Xeon, github.com/gauravvij/kokoro-tts-vs-supertonic-3-tts):")
    for name, rtf in (("Kokoro-82M ONNX, RTF 0.64", 0.64), ("Supertonic-3 5-step, RTF 0.24", 0.24)):
        cf = audio_s_month * rtf * 4 * TTS["cf_vcpu_s"]
        mo = audio_s_month * rtf * 2 * (TTS["modal_cpu_core_s"] + 6 * TTS["modal_ram_gib_s"])   # 2 physical cores + 6 GiB
        print(f"  {name}: Cloudflare Containers ${cf:,.0f}; Modal CPU (2 cores + 6 GiB) ${mo:,.0f}; boxes needed on average = {d['audio_h_day']*rtf/24:.2f} (4 vCPU each)")
    print("\nManaged TTS references: Workers AI Aura-1 $%.0f/month; ElevenLabs at $0.12 per 1k chars $%.0f/month (HN Watercooler thread, 2025)" % (
        d["chars_day"] * DAYS / 1000 * TTS["aura1_per_1k"], d["chars_day"] * DAYS / 1000 * TTS["eleven_per_1k"]))


def totals(a, d):
    """Monthly total by design and scale (12 months of media kept; poll mechanism; optional DO-WS nudge shown separately)."""
    store = cf_storage(d["gb_month_new"], 12)
    base = CF["base"] + max(0, 3 * a.comments_day * DAYS - CF["q_free"]) * CF["q_op"] + store
    llm = {"Qwen3.7-Flash": llm_month(a, "Qwen3.7-Flash (Alibaba SG)"), "Haiku 5.5": llm_month(a, "Haiku 5.5")}
    designs = [("D1 lean CPU: AX42 + Qwen3.7-Flash", TTS["ax42_eur"] * EUR_USD, llm["Qwen3.7-Flash"], TTS["ax42_setup_eur"] * EUR_USD),
               ("D2 recommended: GEX45 + Haiku 5.5", TTS["gex45_eur"] * EUR_USD, llm["Haiku 5.5"], TTS["gex45_setup_eur"] * EUR_USD),
               ("D3 serverless GPU, real time + Haiku 5.5", HOURS_MONTH * TTS["modal_l4_h"], llm["Haiku 5.5"], 0.0),
               ("D4 managed TTS (Aura-1) + Haiku 5.5", d["chars_day"] * DAYS / 1000 * TTS["aura1_per_1k"], llm["Haiku 5.5"], 0.0)]
    print(f"\nTOTAL $/month at {a.kbps:g} kbps, C sustained {a.hours_day:g} h/day (CF base+queues+12-month storage = ${base:,.2f}; poll live updates and R2 miss reads added per C)")
    print("| Design | fixed (TTS + LLM + CF base) | + viewers at 1k | 10k | 100k | one-off setup | + optional DO-WS nudge at 1k / 10k / 100k |")
    print("|---|---|---|---|---|---|---|")
    for name, tts, l, setup in designs:
        fixed = base + tts + l
        cols, ws = [], []
        for C in (1000, 10000, 100000):
            pc, _ = live_update(C, a.hours_day, a, "poll"); mc, _ = r2_miss_cost(C, a.hours_day, a); wc, _ = live_update(C, a.hours_day, a, "ws")
            cols.append(fixed + pc + mc); ws.append(wc)
        print(f"| {name} | ${fixed:,.0f} | ${cols[0]:,.0f} | ${cols[1]:,.0f} | ${cols[2]:,.0f} | ${setup:,.0f} | +${ws[0]:,.0f} / +${ws[1]:,.0f} / +${ws[2]:,.0f} |")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--comments-day", type=float, default=12000)
    p.add_argument("--chars", type=float, default=250)
    p.add_argument("--cps", type=float, default=15, help="spoken characters per second")
    p.add_argument("--kbps", type=float, default=24)
    p.add_argument("--curve-bytes", type=float, default=3000, help="lip-sync curves + tags per comment (ASSUMPTION)")
    p.add_argument("--tok-in", type=float, default=300); p.add_argument("--tok-out", type=float, default=40)
    p.add_argument("--gpu-hours-day", type=float, default=5, help="busy GPU-hours per day")
    p.add_argument("--hours-day", type=float, default=24, help="hours/day the concurrency C is sustained")
    p.add_argument("--session-min", type=float, default=20)
    p.add_argument("--poll-s", type=float, default=3); p.add_argument("--ttl-s", type=float, default=2)
    p.add_argument("--miss-rate", type=float, default=0.005, help="share of audio requests that reach R2 (ASSUMPTION)")
    p.add_argument("--upper-tiers", type=float, default=10, help="upper-tier PoPs refilling head.json (ASSUMPTION)")
    p.add_argument("--sockets-per-do", type=float, default=8000, help="planned WebSockets per shard (ASSUMPTION)")
    p.add_argument("--ws-cpu-ms", type=float, default=2); p.add_argument("--sse-cpu-ms", type=float, default=10)
    p.add_argument("--fanout-s", type=float, default=0.12, help="active seconds per shard per broadcast (ASSUMPTION)")
    a = p.parse_args()
    d = pipeline(a)
    print(f"spoken audio/day = {d['audio_h_day']:.1f} h; clip = {d['clip_s']:.1f} s; bytes/comment = {d['bytes_comment']/1e3:.1f} kB; new data = {d['gb_month_new']:.1f} GB/month")
    print(f"GPU busy fraction at {a.gpu_hours_day} GPU-h/day = {a.gpu_hours_day/24:.0%}; implied RTF = {a.gpu_hours_day/d['audio_h_day']:.3f}")
    print("\nR2 storage $/month if everything is kept: " + ", ".join(f"after {m} mo: ${cf_storage(d['gb_month_new'], m):.2f}" for m in (1, 6, 12, 24)))
    n = a.comments_day * DAYS
    print(f"R2 Class A (1 bundle + 1 head update per comment): {2*n/1e6:.2f}M ops -> ${max(0, 2*n-CF['r2_a_free'])*CF['r2_a']:.2f}")
    print(f"Queues ({n:,.0f} msgs x 3 ops): ${max(0, 3*n-CF['q_free'])*CF['q_op']:.2f};  ingest DO always-on (128 MB): ${max(0, 0.125*DAYS*86400-CF['do_gbs_free'])*CF['do_gbs']:.2f}")
    tts_table(a, d)
    print("\nLLM tagging $/month (real-time list price, no cache, no batch):")
    for k in LLM: print(f"  {k:34s} ${llm_month(a, k):8.2f}")
    print(f"\nLive-update + egress at C concurrent viewers, sustained {a.hours_day} h/day (viewer-hours = C x {a.hours_day} x 30)")
    print("| C | viewer-hours/mo | audio egress TB/mo | R2+CF egress | Bunny Volume ref. | R2 reads on cache misses | poll (CDN) | DO-WS hibernation | SSE via DO | audio GETs/mo | poll GETs/mo |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    for C in (1000, 10000, 100000):
        vh = C * a.hours_day * DAYS; tb = egress(C, a.hours_day, a)
        pc, preq = live_update(C, a.hours_day, a, "poll"); wc, _ = live_update(C, a.hours_day, a, "ws"); sc, _ = live_update(C, a.hours_day, a, "sse")
        mc, areq = r2_miss_cost(C, a.hours_day, a)
        print(f"| {C:,} | {vh:,.0f} | {tb:,.1f} | $0 | ${bunny(tb):,.0f} | ${mc:,.2f} | ${pc:.2f} | ${wc:,.2f} | ${sc:,.2f} | {areq/1e9:,.2f} B | {preq/1e9:,.1f} B |")
    totals(a, d)


if __name__ == "__main__":
    main()
