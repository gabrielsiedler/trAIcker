# Why this way, and not a timer

> The short version of this argument is in the [README](../README.md#why-this-way).
> This is the long one.

Three things already claim to measure a developer's day. Each of them was
designed for a day that doesn't exist anymore. This one:

<div align="center">
  <img src="images/three-metrics.svg" width="880" alt="One afternoon across three projects. Human focus never overlaps itself, agent runs overlap freely, and occupancy is the union of the two.">
</div>

## The manual timer

Toggl, Harvest and everything shaped like them need one input you can't reliably
give while orchestrating: a decision, at the moment of the switch, about which
project you are on now. You send an agent on one client, move to the next while
it works, come back when it stops. The switch happens several times an hour, in
the middle of thinking, and that's exactly when you have no attention left for
bookkeeping.

The failure is silent, and it goes both ways but not evenly. Hours you forget to
start are just gone, and you find out at the end of the month, when
reconstructing them means guessing. A timer you forget to stop is worse, because
it doesn't look like a mistake. It bills a client for your dinner, and the
number lands on an invoice looking as solid as a true one.

Even if you keep it perfectly, the timer can't describe the afternoon at the top
of this page. It has one cursor and the day has three. Ask it "which project are
you on" while five agents run across three clients and it wants an answer that
isn't false. There isn't one.

## Commits, PRs, lines of code

The moment agents started writing the code, output volume became the easiest
signal to fake. An afternoon of agent runs is a plausible month of commits. A
diff of four thousand lines now costs one prompt and no thought. Any metric
built on that counts the thing that just got cheap, and it rewards the exact
behaviour you shouldn't want from someone billing you by the hour.

It also says nothing about work with no artefact. The hour you spent deciding
that a feature should not be built produces no commit, and it was the most
valuable hour of the week.

Time isn't a perfect proxy for value. Nothing is. But it's the honest one, and
the hardest to inflate, because an hour has to actually pass.

## IDE activity trackers

WakaTime, RescueTime and similar tools measure keystrokes and the window in
focus. That input *collapses* when the work goes well: the better your prompt,
the less you type, so the tool reads your best afternoon as your least
productive one.

They're blind in the other direction too. An agent working for forty minutes
shows up as forty idle minutes, because nobody touched the keyboard. And "idle"
is the word that ends up in front of a client. trAIcker treats that same window
as the interesting one, and asks a different question: not *were you typing*,
but *was this project being worked on*.

## Why occupancy is the billable number

Half an hour spent planning a migration, two hours of agents running it while
you correct them, and a migration that works at the end. A tracker built around
one active task records half an hour. That's the number a client gets invoiced
for, and it's the wrong one.

<div align="center">
  <img src="images/one-task.svg" width="880" alt="One task: half an hour of orchestration, two hours of execution, two and a half hours of occupancy.">
</div>

The half hour is not the work made smaller, it's the work made denser, and it's
the part only you can do. Give the same two hours of execution to someone who
can't write that half hour and the client gets two hours of confident nonsense,
delivered on time. A developer is hired to guarantee quality, reliability and
delivery. That obligation didn't move when agents started writing the code. It
just stopped being paid off by typing.

Which is why billing focus alone is a trap with a sharp edge:

> ### The better you get at this, the less you earn.
>
> Every improvement in how you brief and correct an agent makes the interval
> focus measures shorter. It's the same mistake an IDE activity tracker makes,
> moved off the measurement layer and onto the invoice.

Occupancy answers the question hourly billing has always answered: how long was
this being worked on. An agent that flounders for an hour bills like a slower
engineer's hour would, and you're the one who has to notice it floundering.

**"So if you get faster, do I pay less?"** For the same piece of work, yes, and
that's not a hole in the argument. It's how hourly billing has always behaved.
What moves is the rate. An hour that now carries two hours of directed execution
is not the hour you sold two years ago, and pricing it the same is the real
mistake. Time is the unit, the rate is where skill gets paid. Settle that up
front and a client watching you get faster is watching their budget go further,
not watching a meter.

**"Isn't billing two projects for the same hour charging twice?"** It would be,
if an hour of occupancy meant your attention was only there. It doesn't, and
trAIcker must never be presented as if it did. Occupancy overlaps across
projects, so three of them running in parallel can add up to more than the day
is long. That's a real property of the working model. Two clients each got an
hour of engineering. Neither was promised that nobody else did.

And to be plain about the part that's easy to fudge: **you don't have to be
watching for the time to count.** What you answer for is the result. You picked
the approach, you sent the run, and your name is on what lands. A client who
buys presence instead of delivery is buying something different, and that's
legitimate. It has its own setting: put their `billing.basis` on `focus` and the
same log answers their question. The one thing that must never happen is selling
one and reporting the other.

The tool is built to keep that distinction intact instead of flattering the
total. The 40-minute gap in the diagram at the top is thrown away, not smoothed
over. A weekly cap is reported when you go past it, never quietly trimmed to
fit. Prompt text never reaches an invoice unless you opt in. A number you're
about to send someone should be one you can defend line by line, which is the
whole reason the timeline exists.
