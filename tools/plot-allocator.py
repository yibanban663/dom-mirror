"""Plot a completed host-profile comparison; matplotlib is optional."""
import json
import sys
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

source, target = map(Path, sys.argv[1:3])
report = json.loads(source.read_text())
assert report["complete"]
fig, axes = plt.subplots(1, 2, figsize=(12, 5))
for profile, color in zip(report["profiles"], ["#235d9f", "#21866f"]):
    group = profile["report"]["groups"][0]
    axes[0].plot([p["cycle"] for p in group["cycles"]], [p["anonGrowthMiB"] for p in group["cycles"]],
                 label=profile["allocator"], color=color, marker=".")
axes[0].axhline(64, color="#ba3b52", linestyle="--", label="64 MiB budget")
axes[0].set_title("Normal cleanup: anonymous growth")
axes[0].set_xlabel("Create / operate / reclaim cycle")
axes[0].legend(frameon=False, fontsize=9)
labels, snapshots = [], []
for profile in report["profiles"]:
    for key, phase in [("10-postIdle", "normal"), ("10-finalSettled", "after GC")]:
        labels.append(profile["allocator"] + "\n" + phase)
        snapshots.append(profile["mappings"][key]["categories"])
bottom = [0] * 4
for key, label, color in [("unnamed", "Unnamed", "#235d9f"), ("mainHeap", "Main heap", "#c26c23"),
                          ("fileBacked", "File mappings", "#21866f"), ("unnamedExecutable", "Unnamed executable", "#77589c"),
                          ("mainStack", "Main stack", "#ba3b52"), ("namedOther", "Other named", "#777777")]:
    values = [p.get(key, {}).get("anonMiB", 0) for p in snapshots]
    axes[1].bar(range(4), values, bottom=bottom, label=label, color=color)
    bottom = [a + b for a, b in zip(bottom, values)]
axes[1].set_ylim(0, max(bottom) * 1.12)
axes[1].set_xticks(range(4), labels)
axes[1].set_title("Mapping anonymous pages (absolute)")
axes[1].legend(frameon=False, fontsize=8, ncol=2, loc="upper center", bbox_to_anchor=(0.5, -0.17))
for ax in axes:
    ax.set_ylabel("MiB")
    ax.grid(axis="y", alpha=0.2)
    ax.set_axisbelow(True)
fig.suptitle("Host profiles: glibc arena=2 versus jemalloc + background decay", fontsize=12)
fig.text(0.5, 0.015, "10 cycles per profile, 3 sessions per cycle; no normal-cycle forced GC or trim. Unnamed mappings have no proven owner.",
         ha="center", fontsize=8, color="#555555")
fig.tight_layout(rect=(0, 0.1, 1, 0.94))
target.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(target, dpi=160)
plt.close(fig)
