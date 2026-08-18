# The dashboard

```bash
traicker serve                   # http://localhost:4317
```

Five tabs, in the order the day actually goes:

| Tab | What it holds |
| --- | --- |
| **Overview** | The metric cards, then the timeline. |
| **Timesheet** | Day lines for one client, by billing week. |
| **Projects** | The totals table, billable and all. |
| **Entries** | Time logged off the tools, and the day's list. |
| **Settings** | Project name, client, colour, billable, caps, billing, written through to `config.json`. |

The range picker in the header drives the cards and the timeline together, so
the two always describe the same period. The timesheet ignores it and works in
billing weeks, because a weekly cap is contractual and a rolling window matches
neither week.

The timeline comes second because it's the view that answers *why* a number is
what it is. Billable projects sort to the top and keep full contrast. Everything
else is dimmed below them, and the filter narrows to one group when that's all
you want.

It draws itself two ways, picked from the data and not from the range you chose:

- **By hour**, up to two days: real start and end times, with one lane per
  concurrent agent, so parallelism shows up as height.
- **By day**, past that: one bar per project per day, on a single scale. Four
  hundred spans across a 750-pixel axis put a two-minute agent run at under a
  pixel, and the strip turns into a smear you can't read or trust. So past a
  couple of days the unit changes from the hour to the day. Time of day is lost,
  and every bar becomes a quantity you can compare across a fortnight. Days with
  nothing on them still get a column, because a gap is information.

There's no "what you worked on" panel. It grouped by session title, and Claude
Code names a session once, from its opening minutes. A session that runs all day
through `/clear` and a dozen subagents still reports its first name, so the
grouping was never fine enough to be worth a view. The data still drives
timesheet descriptions, and `traicker topics --detail` still shows one row per
prompt in the terminal, which is the resolution that view needed and never had.

## Timesheets, as a panel

The dashboard carries the same timesheet the CLI builds, with week navigation
and per-row copy buttons. The client's form is already open in another tab, and
copying out of a terminal into a web form is the friction that makes a tracker
stop getting used. The panel only shows up for projects that have billing rules.

See [Billing](billing.md) for the cap, the rounding, and where a line's text
comes from.
