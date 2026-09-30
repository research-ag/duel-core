// A step-by-step guide for building a canister-player BOT against an
// already-built game (see TutorialWizard.tsx for the sibling "build a new
// game" wizard). A bot is inherently game-specific — it imports its
// target game's own Rules module to type `make_move` — so unlike a game,
// there's nothing to register on THIS dashboard: the last step is a
// one-time Motoko-to-Motoko call the bot itself makes to its own game
// canister, not a form on this page. This is a browser page, so every
// step is copy-pasteable commands for the developer's own terminal, never
// something this frontend runs itself.

import { useState } from "react";

import { CodeBlock } from "./CodeBlock";
import { Wizard } from "./Wizard";

const STEPS = [
  "Prerequisites",
  "Project setup",
  "Write the bot",
  "Deploy",
  "Register with the game",
] as const;

export function BotTutorialWizard({ onClose }: { onClose: () => void }) {
  return (
    <Wizard
      kicker="Build a bot"
      title="A canister player for any listed game."
      steps={STEPS}
      onClose={onClose}
      finish={{ label: "Done", onClick: onClose }}
      render={(step) => (
        <>
          {step === 0 && <PrerequisitesStep />}
          {step === 1 && <ProjectSetupStep />}
          {step === 2 && <WriteBotStep />}
          {step === 3 && <DeployStep />}
          {step === 4 && <RegisterStep />}
        </>
      )}
    />
  );
}

function PrerequisitesStep() {
  return (
    <>
      <p>
        A bot deploys as a single extra canister alongside a game's own two
        (backend + frontend) — it plays through the same session engine every
        duel-game-core game already runs on. Before writing any code, make sure
        your machine can create and deploy it.
      </p>
      <ol className="tutorial-list">
        <li>
          Install <code>icp-cli</code>, the tool used to build and deploy — see
          the{" "}
          <a
            href="https://github.com/dfinity/icp-cli"
            target="_blank"
            rel="noreferrer"
          >
            icp-cli project
          </a>{" "}
          for install instructions. Verify it's on your PATH:
          <CodeBlock code="icp --version" />
        </li>
        <li>
          Already have an identity you want to deploy with? Skip this — it's
          optional. Otherwise, check what you have and switch to the right one:
          <CodeBlock
            code={
              "icp identity list       # your existing identities\nicp identity default    # which one is currently selected"
            }
          />
          Or create a fresh one and switch to it (this is your deploy key — keep
          it safe, it controls your canister):
          <CodeBlock
            code={"icp identity new my-bot\nicp identity default my-bot"}
          />
        </li>
        <li>
          Get enough cycles to create and deploy 1 more canister, with some
          margin — aim for at least ~2–3T cycles to start comfortably (less than
          a full game needs, since a bot has no separate frontend canister).
          Check what you already have:
          <CodeBlock code="icp cycles balance -e ic" />
          If that's already enough, skip ahead. Otherwise, get your principal —
          the address cycles attach to:
          <CodeBlock code="icp identity principal" />
          Already hold some ICP? Convert it directly:
          <CodeBlock code="icp cycles mint --icp 1 -e ic" />
          Don't have any ICP? The easiest option is buying cycles straight with
          a credit card via{" "}
          <a href="https://cycle.express/" target="_blank" rel="noreferrer">
            cycle.express
          </a>{" "}
          — no exchange account needed. Open this URL with your own principal
          (from above) in place of <code>&lt;principal&gt;</code>:
          <CodeBlock code="https://cycle.express/?to=<principal>" />
        </li>
      </ol>
    </>
  );
}

function ProjectSetupStep() {
  return (
    <>
      <p>
        A bot is its own project, with its own <code>mops.toml</code> and its
        own single-canister <code>icp.yaml</code> — it deploys separately from
        the game it plays, and doesn't need that game's own repo, build tooling,
        or dependencies at all.
      </p>
      <CodeBlock code={"mkdir my-bot && cd my-bot\ngit init"} />
      <p>
        The one thing it DOES need from the target game is a plain Motoko type
        it can type <code>make_move</code> against — <code>State</code> and{" "}
        <code>Action</code>, exactly as that game's own Rules module defines
        them. There's no dependency to add for this: copy just those two type
        definitions (and anything they reference) out of the game's own source
        into a small file in your own project — e.g. <code>GameTypes.mo</code> —
        rather than pulling in the whole game as a dependency, which would drag
        in its host actor, its engine wiring, and everything else a bot has no
        use for.
      </p>
      <p className="hint">
        <code>examples/racing/bot/</code> and{" "}
        <code>examples/checkers/bot/</code> in{" "}
        <a
          href="https://github.com/research-ag/duel-core"
          target="_blank"
          rel="noreferrer"
        >
          research-ag/duel-core
        </a>{" "}
        are two complete, worked bot canisters — copy either one's shape (a
        `Bot.mo` + `BotLogic.mo` pair) as a starting point regardless of which
        game you're targeting. Both happen to sit inside the same repo as the
        game they play, since they're reference examples for this framework
        itself — your own bot has no reason to; it's a normal, independent
        project like any other.
      </p>
    </>
  );
}

function WriteBotStep() {
  return (
    <>
      <p>A bot canister is three methods on top of an ordinary Motoko actor:</p>
      <ol className="tutorial-list">
        <li>
          <strong>make_move</strong> — the move-selection logic itself, called
          once per round the bot is due to move. A bot whose whole strategy is a
          function of the current board can declare this a <code>query</code>{" "}
          (near-instant, no consensus needed); a bot that remembers anything
          across calls (a match's own move history, a model of a specific
          opponent) needs an ordinary <code>update</code> method instead — see{" "}
          <a
            href="https://github.com/research-ag/duel-core/blob/main/skills/duel-game-core/references/canister-player-bots.md"
            target="_blank"
            rel="noreferrer"
          >
            references/canister-player-bots.md
          </a>{" "}
          for the full design guide, both shapes worked out.
        </li>
        <li>
          <strong>play(host, tableId, seat, code)</strong> — this bot's own
          self-join entry point: a frontend hands it a game canister's own id, a
          table id, a seat, and that table's access code, and it calls that
          game's own <code>join_table_as_canister</code> on its own account.
        </li>
        <li>
          <strong>register(host, name)</strong> — self-registration, so this bot
          can be found and challenged at all (step 5, below): forwards to{" "}
          <code>host</code>'s own <code>register_bot</code>.
        </li>
      </ol>
      <p>
        The full worked shape of all three — copy-and-fill templates included —
        is written down here:
      </p>
      <p>
        <a
          href="https://github.com/research-ag/duel-core/blob/main/backend/README.md"
          target="_blank"
          rel="noreferrer"
        >
          backend/README.md
        </a>
        's "Canister players" section
      </p>
      <p>
        <strong>Shortcut for agentic development</strong>
      </p>
      <p>
        Working with an AI coding assistant (e.g. Claude Code)? Install the same
        playbook this game's own skeleton was built from as a skill in your
        project directory instead of reading it yourself:
      </p>
      <CodeBlock code="npx skills add research-ag/duel-core --skill duel-game-core" />
      <p className="hint">
        Then just ask it something like: "Build a canister-player bot for this
        game." The skill's own "Canister players (optional)" step walks the
        assistant through the whole make_move/play/register workflow.
      </p>
    </>
  );
}

function DeployStep() {
  return (
    <>
      <p>
        Once your bot is filled in, build and test locally first (from your own
        project's root):
      </p>
      <CodeBlock code={"mops install\nmops test"} />
      <p>
        Then deploy it to the Internet Computer mainnet — this is the step that
        spends cycles:
      </p>
      <CodeBlock code="icp deploy -e ic -y" />
      <p>
        Note the printed canister id — the next step needs it, alongside the
        game's own backend canister id.
      </p>
    </>
  );
}

function RegisterStep() {
  return (
    <>
      <p>
        Last step — self-register this bot with the game so players can find and
        challenge it. This is a one-time Motoko-to-Motoko call, not a form on
        this dashboard (a bot is never listed here the way a game is): the bot
        canister itself calls the game's own <code>register_bot</code>, under
        its own principal, so there's nothing to spoof.
      </p>
      <CodeBlock
        code={
          'icp canister call bot register \'(principal "<game-backend-canister-id>", "<Your Bot Name>")\''
        }
      />
      <p>
        Once this succeeds, the bot shows up in every player's own "🤖 Bots"
        challenge dialog and leaderboard Challenge button on that game's
        frontend — nothing further to do.
      </p>
    </>
  );
}
