"""Draws docs/images/scale-tests.png: the eleven numbered attempts to run 10,000 documents.

Every number below is copied from docs/scale-test-history.md (the "Attempts" table). Nothing is estimated.
Attempts r03, r04, r05 and r08 never processed a document: three stopped on test-setup errors and one was not
started because the sign-in had too little time left. They are marked "did not run" rather than drawn as zero.
r06 is a real zero: one upload in 9,461 was refused, so no document was processed.

Run from anywhere:  python docs/images/scale-tests.py
Needs matplotlib and seaborn (any recent version). The PNG is written beside this script.
"""
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns
from matplotlib.lines import Line2D
from matplotlib.patches import Patch

TARGET = 10_000

# (attempt, documents that reached an outcome, what happened)
ATTEMPTS = [
    ("r01", 6_647, "stopped"),
    ("r02", 4_498, "stopped"),
    ("r03", None, "did not run"),
    ("r04", None, "did not run"),
    ("r05", None, "did not run"),
    ("r06", 0, "stopped"),
    ("r07", 8_631, "stopped"),
    ("r08", None, "did not run"),
    ("r09", 5_162, "stopped"),
    ("r10", 9_996, "stopped"),
    ("r11", 10_000, "completed"),
]

ACCENT = "#4c7fe0"      # the attempt that reached the target
MUTED = "#a7afb8"       # attempts that stopped short
INK = "#3f4750"         # text
INK_SOFT = "#6e7681"    # secondary text
GRID = "#e6e8eb"

sns.set_theme(style="white", font="DejaVu Sans")
fig, ax = plt.subplots(figsize=(10, 5.2), dpi=160)
fig.patch.set_facecolor("white")
ax.set_facecolor("white")

positions = list(range(len(ATTEMPTS)))
for x, (name, decided, state) in zip(positions, ATTEMPTS):
    if decided is None:
        ax.text(x, 120, "did not run", rotation=90, ha="center", va="bottom", fontsize=9, color=INK_SOFT)
        continue
    colour = ACCENT if state == "completed" else MUTED
    ax.bar(x, decided, width=0.42, color=colour, linewidth=0, zorder=3)
    if state == "stopped" and decided > 0:
        ax.plot(x, decided + 180, marker="x", color=INK, markersize=7, markeredgewidth=1.6, linestyle="none", zorder=4)

# the target, labelled once
ax.axhline(TARGET, color=INK_SOFT, linewidth=1, linestyle=(0, (4, 3)), zorder=2)
ax.text(-0.5, TARGET + 200, "target: 10,000 documents", ha="left", va="bottom", fontsize=9.5, color=INK_SOFT)

# selective direct labels: the near miss and the attempt that reached the target
ax.text(9, 9_996 + 520, "9,996", ha="center", va="bottom", fontsize=9.5, color=INK)
ax.text(10, 10_000 + 520, "10,000", ha="center", va="bottom", fontsize=10, color=INK, fontweight="bold")
ax.text(5, 120, "0: an upload was refused", rotation=90, ha="center", va="bottom", fontsize=9, color=INK_SOFT)

ax.set_xticks(positions, [name for name, _, _ in ATTEMPTS])
ax.set_xlim(-0.6, len(ATTEMPTS) - 0.4)
ax.set_ylim(0, 11_600)
ax.set_yticks(range(0, 10_001, 2_000))
ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f"{int(v):,}"))
ax.yaxis.grid(True, color=GRID, linewidth=1, zorder=0)
ax.set_axisbelow(True)
ax.tick_params(axis="both", colors=INK_SOFT, labelsize=9.5, length=0)
for side in ("top", "right", "left"):
    ax.spines[side].set_visible(False)
ax.spines["bottom"].set_color(GRID)

ax.set_xlabel("Attempt on the practice deployment, 6 to 9 October 2026", fontsize=10, color=INK, labelpad=10)
ax.set_ylabel("Documents that reached an outcome", fontsize=10, color=INK, labelpad=10)
ax.set_title("Eleven attempts to put 10,000 documents through the hosted system",
             fontsize=12.5, color=INK, loc="left", pad=28, fontweight="bold")
ax.text(0, 1.045, "Pretend AI services answered, so no paid model call was made. "
        "Source: docs/scale-test-history.md",
        transform=ax.transAxes, fontsize=9.5, color=INK_SOFT, ha="left", va="bottom")

legend = ax.legend(
    handles=[
        Patch(facecolor=MUTED, label="stopped before 10,000"),
        Line2D([], [], marker="x", color=INK, linestyle="none", markersize=7, markeredgewidth=1.6,
               label="where it stopped (the reason is in the history table)"),
        Patch(facecolor=ACCENT, label="every document reached an outcome"),
    ],
    loc="upper center", bbox_to_anchor=(0.5, -0.17), ncol=3, frameon=False, fontsize=9.5, labelcolor=INK,
    handlelength=1.4, columnspacing=2.0,
)

fig.tight_layout()
out = Path(__file__).with_name("scale-tests.png")
fig.savefig(out, dpi=160, facecolor="white")
print(f"wrote {out}")
