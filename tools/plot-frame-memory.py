"""Render a completed diagnostic summary; matplotlib is an optional analysis dependency."""
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

source, target = map(Path, sys.argv[1:3])
report = json.loads(source.read_text())
assert report["complete"], "Only plot a complete experiment"
labels = {"default": "Default", "gc": "Forced GC", "cache-off": "Cache off", "gc-cache-off": "GC + cache off",
          "arena-2": "Arena cap=2 (default GC/cache)"}
colors = {"default": "#235d9f", "gc": "#c26c23", "cache-off": "#21866f", "gc-cache-off": "#77589c", "arena-2": "#ba3b52"}
fig, axes = plt.subplots(1, 2, figsize=(11, 4.8))
groups = report["groups"]
if "allocatorSupplement" in report:
    groups = groups + [{**report["allocatorSupplement"]["result"]["groups"][0], "group": "arena-2"}]
for group in groups:
    cycles = [row["cycle"] for row in group["cycles"]]
    for ax, field in zip(axes, ["anonGrowthMiB", "externalMiB"]):
        ax.plot(cycles, [row[field] for row in group["cycles"]], marker="o", markersize=3,
                color=colors[group["group"]], label=labels[group["group"]], linewidth=1.6)
for ax in axes:
    ax.set_xlabel("Create / operate / reclaim cycle")
    ax.set_ylabel("MiB")
    ax.set_xticks(range(1, 11))
    ax.grid(alpha=0.2)
axes[0].set_title("Anonymous memory above baseline")
axes[1].set_title("Node external memory")
fig.legend(*axes[0].get_legend_handles_labels(), loc="lower center", bbox_to_anchor=(0.5, 0.06),
           ncol=3, frameon=False, fontsize=9)
fig.suptitle("Frame memory after idle and diagnostic intervention", fontsize=12)
fig.text(0.5, 0.025, "3 sessions per cycle; GC, cache and arena controls are isolated diagnostics, not package defaults.",
         ha="center", fontsize=8, color="#555555")
fig.tight_layout(rect=(0, 0.19, 1, 0.94))
target.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(target, dpi=160)
plt.close(fig)
