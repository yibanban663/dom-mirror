"""Plot a completed long lifecycle diagnostic (optional matplotlib dependency)."""
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

source, target = map(Path, sys.argv[1:3])
report = json.loads(source.read_text())
assert report["complete"], "Only plot complete evidence"
assert report["plan"]["cycles"] == 30 and report["plan"]["nativeProbe"], "Expected the 30-cycle native-probe plan"
group = report["groups"][0]
cycles = group["cycles"]
fig, axes = plt.subplots(1, 3, figsize=(14, 4.6))
x = [point["cycle"] for point in cycles]
axes[0].plot(x, [p["anonGrowthMiB"] for p in cycles], color="#235d9f", marker=".")
axes[0].axhline(report["plan"]["budget"]["postCleanupAnonGrowthMiB"], color="#ba3b52", linestyle="--", label="64 MiB budget")
axes[0].set_title("Anonymous growth above baseline")
axes[0].legend(frameon=False, fontsize=8)
for field, label, color in [("systemMiB", "System", "#235d9f"), ("freeMiB", "Free", "#21866f"),
                             ("inUseEstimateMiB", "In-use estimate", "#c26c23")]:
    axes[1].plot(x, [p["native"][field] for p in cycles], label=label, color=color)
axes[1].set_title("glibc accounting (not RSS)")
axes[1].legend(frameon=False, fontsize=8)
points = group["finalDiagnostics"]
bars = axes[2].bar(range(len(points)), [p["after"]["anonMiB"] for p in points],
                   color=["#235d9f", "#c26c23", "#21866f", "#77589c"])
axes[2].bar_label(bars, fmt="%.1f", padding=3, fontsize=8)
axes[2].margins(y=0.15)
axes[2].set_xticks(range(len(points)), ["Idle", "GC", "Trim", "+3s"])
axes[2].set_title("Terminal diagnostic: absolute anon")
for ax in axes[:2]:
    ax.set_xlabel("Create / operate / reclaim cycle")
    ax.set_xticks([1, 5, 10, 15, 20, 25, 30])
for ax in axes:
    ax.set_ylabel("MiB")
    ax.grid(axis="y", alpha=0.2)
    ax.set_axisbelow(True)
fig.suptitle("Frame: 30 cycles, arena cap=2, libvips concurrency=1", fontsize=12)
fig.text(0.5, 0.02, "3 sessions / cycle; no forced GC or trim during normal cycles. Terminal interventions do not count toward the budget.",
         ha="center", fontsize=8, color="#555555")
fig.tight_layout(rect=(0, 0.07, 1, 0.94))
target.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(target, dpi=160)
plt.close(fig)
