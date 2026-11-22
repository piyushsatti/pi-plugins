# Global Manifold and its spaces

This is the plugin's application/storage contract, directed by its user on 2026-09-27.
It is not a new ontology provision or a claim that the standard mandates a directory
layout. Source definitions and scoped acceptance remain unchanged.

## One global home, multiple spaces

Manifold is global to the user. Dedicated spaces live under
`$MANIFOLD_STATE/spaces/`, or `~/.local/state/manifold/spaces/` when MANIFOLD_STATE is unset.
MANIFOLD_STATE must be an absolute, user-wide location outside project/repository directories;
do not load a project `.env` or infer it from the current working directory.
The same global root is used whether the session starts at home or in a repository.
A space can concern a household, organization, service, research area or project;
it is never owned by that project's directory. Spaces are organizational containers,
not a new Manifold concept or a claim that each is an independent installed product.

Use [the small space helper](../bin/manifold-spaces) with Python 3 for path resolution,
listing and append-only checkpoints. It is installed as `manifold-spaces` on `PATH`
(`~/.local/bin/manifold-spaces`); call that, never a copy found from cwd:

```sh
manifold-spaces root
manifold-spaces list
manifold-spaces latest --space household-care
manifold-spaces checkpoint --space household-care --content-file /path/to/round.md
```

`root`, `list` and `latest` do not create anything. Listing reveals space names and
latest checkpoint paths, not their contents. Read only the selected space. If a name
is ambiguous, ask which one. Do not select a space from cwd, Git remote, basename or
an inferred organization. A display name can keep the user's wording; the directory
slug is just a safe local filename, not a registered identity.

Creating a space follows the user's choice to establish it and produces the first
useful checkpoint, not an empty setup scaffold. Calling init again resumes that
space; it never resets it. Each checkpoint is a consolidated, readable current view
with prior checkpoint/source links and stable claim handles where already present.
Write a new checkpoint after a substantive guided round within the authorized
establishment work; read it back and report where it lives. Recording a proposed
interpretation does not adopt it. No repeated permission question is needed for
already-authorized checkpoint writes.

Space history remains append-only. The latest checkpoint is a continuation aid, not
proof that every statement is accepted. Conflicting concurrent accounts stay visible
and require reconciliation; never discard earlier checkpoints. No mutable global
"active project" mapping or project-local fallback is used. Existing unrelated local
artifacts can be authorized sources; do not silently relocate or convert them.

The helper rejects a relative MANIFOLD_STATE, repository-contained roots and symlink escapes.
It cannot identify every non-Git project directory: the agent must also enforce the
user-wide-root rule. If global storage is inaccessible, keep a provisional reply in
chat and explain the exact blocker. Do not write into the current project instead,
or claim progress was saved. Python 3 is needed only for durable space operations;
conceptual guidance and an unsaved conversation remain available without it. There
is no automatic synchronization between computers or grant of access to other people.

## First contact

For bare “Manifold” or first `init`, explain briefly:

> Manifold connects **needs**—whose desired conditions matter—**requirements**—what
> must hold—and **systems**—how things are organized and work. It helps reveal
> unclear expectations, missing pieces, and solutions that do not serve the needs
> they were intended to address.
>
> Your Manifold lives globally, with dedicated spaces for different areas of life
> or work. Establishing a useful foundation takes focused time and may span several
> sessions. We establish that foundation once, then build on it as things change.
> This is a guided, hands-on process, not an unattended or AFK setup.
>
> We can start from documents or an interview, and switch between them at any time.
> What area would you like to establish, and which starting approach suits you?

Adapt to what is already supplied. Do not repeat this introduction on every resume,
ask for a mode already chosen, or read every owning reference before this short
welcome. For conceptual wording, read [accepted purpose](source/standard/foundations/purpose-and-scope.md)
and follow the definitions' individual standing when applying them.
If the user says they are stuck, use [help](../skills/help/SKILL.md). Existing spaces
can be resumed without re-establishment. A question about Manifold can be answered
without creating a space.

## Two composable ways to establish

**Document discovery:** agree a small authorized set of files, links or collections.
The user may provide it or ask for help choosing it. Offer selection by relevance to
the area and current question; do not scan a repository, disk, account or connector
merely because it is available. Inspect one useful batch, recording source identity,
revision, author/account and accessibility for intended collaborators. A local path
is not proof that everybody can access it. Link sources; do not relocate the corpus,
change permissions or claim inaccessible sources were read. Extract a small connected
model slice, preserving source claims separately from interpretation. Return gaps
and disagreements, then offer the next useful interview question or source batch.

**Interview:** begin with a question that gets a concrete situation: “What are you
trying to make possible, for whom, and what is difficult today?” Use any answer
already available instead of asking again. Ask one focused question at a time, with
brief follow-ups only when needed. Reflect the person's account separately from your
interpretation. Explore needs, current arrangements and criteria as they become
relevant; do not march through an ontology questionnaire, invent other participants'
views, or demand metrics for qualitative purposes. A referenced document can become
the next discovery batch if the user chooses to provide it.

The conversation can be discovery → interview → discovery → review, or any useful
combination. Neither mode is a permanent choice. Follow an explicit choice already
made; otherwise offer one recommended next step, with switch/pause as alternatives.

## One round at a time

Within an authorized round, the agent can read the agreed sources, reason and draft.
At the round boundary, return a short account of what was learned, the current
needs–requirements–systems connection (including gaps), and what remains uncertain.
Ask the one question or offer the one action that most advances understanding.
Do not run an unattended sequence, schedule discovery, launch agents by default,
or interpret silence as permission to continue interviewing or expand source scope.

A useful round can contain one need and no requirement yet. Never gate progress on a
complete taxonomy, every stakeholder, a filled template, numeric thresholds or an
entire system model. Use the existing seven capabilities as assistance inside this
conversation; users do not need to navigate all seven to get started. Establishment
has no global percent-complete or automatic done decision. A user can choose that the
current foundation is useful enough to work with, retaining named gaps and next steps.

At pause, keep a checkpoint sufficient to resume: selected space/purpose; references
and authorized source scope; accounts, interpretations, proposed/adopted claims;
current small model; open questions; last mode and the specific next step. Resume from
that basis, verify changed/missing sources, and avoid repeating an initial interview.
Use [the checkpoint prompts](../templates/space-checkpoint.md) selectively. Checkpoints
are human-readable notes, not a database schema or a substitute for source evidence.
