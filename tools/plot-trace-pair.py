"""Plot completed matched trace-storage evidence; optional matplotlib dependency."""
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

source, target = map(Path, sys.argv[1:3])
report = json.loads(source.read_text())
host_profile = "sameFilesystemAndSources" in report
assert report["complete"]
if host_profile:
    assert report["sameFilesystemAndSources"]
    runs = [{"storage": run["name"], "analysis": run["result"]["analysis"]} for run in report["runs"]]
else:
    assert report["sameImageAndSources"] and report["samePlanExceptStorage"]
    runs = report["runs"]
fig, axes = plt.subplots(2, 2, figsize=(12, 7.5))
colors = {"memory": "#235d9f", "disk": "#21866f", "default": "#235d9f", "semi4": "#21866f"}
for index, run in enumerate(runs):
    name = run["storage"]
    color = colors[name]
    points = run["analysis"]["series"]
    x = [point["cycle"] for point in points]
    axes[0, 0].plot(x, [p["anonGrowthMiB"] for p in points], marker=".", color=color, label=name)
    axes[0, 1].plot(x, [p["v8Spaces"]["new_space"]["physicalMiB"] for p in points], color=color, label=name)
    axes[1, 0].plot(x, [p["jemallocResidentMiB"] for p in points], color=color, label=name)
    final = run["analysis"]["finalDiagnostics"]
    assert [p["phase"] for p in final] == ["finalIdle", "finalGc", "finalSettled"]
    offset = -0.18 if index == 0 else 0.18
    bars = axes[1, 1].bar([i + offset for i in range(3)], [p["anonMiB"] for p in final], width=0.36, color=color, label=name)
    axes[1, 1].bar_label(bars, fmt="%.1f", padding=3, fontsize=8)
axes[0, 0].axhline(64, color="#ba3b52", linestyle="--", label="64 MiB budget")
for ax, title in zip(axes.flat, ["Normal cleanup: anon growth above baseline", "V8 young-space physical size", "jemalloc resident (not process RSS)", "Terminal diagnostics: absolute anon"]):
    ax.set_title(title, fontsize=11)
    ax.set_ylabel("MiB")
    ax.legend(frameon=False, fontsize=8)
    ax.grid(axis="y", alpha=0.2)
    ax.set_axisbelow(True)
for ax in [axes[0, 0], axes[0, 1], axes[1, 0]]:
    ax.set_xlabel("Create / operate / reclaim cycle")
    ax.set_xticks([1, 5, 10, 15, 20, 25, 30])
    if not host_profile:
        ax.axvspan(16, 20, color="#777777", alpha=0.08)
axes[1, 1].set_xticks(range(3), ["+15s idle", "GC", "+3s"])
axes[1, 1].margins(y=0.15)
fig.suptitle("Frame: default / semi4 startup profiles, 30 cycles each" if host_profile else "Frame: matched memory / disk trace storage, 30 cycles each", fontsize=13)
identity = "Same filesystem, sources, allocator and workload" if host_profile else "Same image, allocator and workload"
fig.text(0.5, 0.02, identity + "; sequential profiles. Normal cycles have no forced GC or trim. Terminal diagnostics excluded from budget.", ha="center", fontsize=8)
fig.tight_layout(rect=(0, 0.05, 1, 0.96))
target.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(target, dpi=160)
plt.close(fig)
