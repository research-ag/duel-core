// "Build a bot": a canister player for a game already listed here, built
// by an AI coding agent from botPrompt.ts's prompt, in a Claude Code
// cloud session first or on the developer's own computer. The agent tests
// it against a local copy of the game made from the module the backend
// runs, then puts it online through hosty.live (or the developer does with
// icp-cli) and has it register itself with the game (a bot is never
// listed on this dashboard). Opened from a game's info dialog it starts filled in
// for that game; from the header it starts by picking one.

import { useState } from "react";

import { botPrompt } from "../botPrompt";
import type { AggregatorActor, GameView, Target } from "../types";
import { gameUrl } from "../types";
import { CloudSessionSetup, HostyAccountSteps } from "./CloudSessionSetup";
import { CodeBlock } from "./CodeBlock";
import { GamePicker } from "./GamePicker";
import { Wizard } from "./Wizard";

const STEPS = [
  "Pick a game",
  "How it works",
  "Set up",
  "Copy the prompt",
  "Build and test",
  "Go live",
] as const;

export function BotTutorialWizard({
  initial,
  games,
  loading,
  actor,
  onClose,
}: {
  initial: Target | undefined;
  games: GameView[];
  loading: boolean;
  actor: AggregatorActor | undefined;
  onClose: () => void;
}) {
  const [target, setTarget] = useState(initial);
  return (
    <Wizard
      kicker="Build a bot"
      title={
        target
          ? `A bot for “${target.game.title}”.`
          : "A bot for a listed game."
      }
      steps={STEPS}
      initialStep={initial ? 1 : 0}
      reachable={target ? STEPS.length - 1 : 0}
      onClose={onClose}
      finish={{ label: "Done", onClick: onClose }}
      render={(step, next) => (
        <>
          {step === 0 && (
            <>
              <p>
                Which game should your bot play? Only games that take bots as
                players can be picked.
              </p>
              <GamePicker
                games={games}
                loading={loading}
                actor={actor}
                purpose="bot"
                picked={target}
                onPick={(t) => {
                  setTarget(t);
                  next();
                }}
              />
            </>
          )}
          {target && step === 1 && <HowItWorksStep />}
          {target && step === 2 && <SetupStep />}
          {target && step === 3 && <PromptStep target={target} />}
          {target && step === 4 && <BuildStep />}
          {target && step === 5 && <GoLiveStep target={target} />}
        </>
      )}
    />
  );
}

function HowItWorksStep() {
  return (
    <>
      <p>
        A bot is a small program of your own that lives on the Internet Computer
        next to the game and plays it. Whenever it is the bot's turn, the game
        asks it for a move and plays whatever it answers. Players pick it from
        the game's list of bots, and it is rated on the leaderboard like anyone
        else. The game itself stays untouched.
      </p>
      <p>
        You don't write it yourself. An AI coding tool does, from a prompt we
        give you plus your own description of how the bot should play: simplest
        is{" "}
        <a href="https://claude.ai/code" target="_blank" rel="noreferrer">
          Claude Code on the web
        </a>
        , with nothing to install, or a coding tool on your own computer
        (Claude Code, Cursor, Codex and the like). It tests the bot against a
        private copy of the game before anything goes online.
      </p>
      <p className="hint">
        A browser-based app builder can't make a bot, since the bot is tested
        next to a copy of the game. Building and testing are free; the bot goes
        online through{" "}
        <a href="https://hosty.live" target="_blank" rel="noreferrer">
          hosty.live
        </a>{" "}
        for 1.5 TC (a few dollars at the time of writing), paid in the last
        step.
      </p>
    </>
  );
}

function SetupStep() {
  return (
    <>
      <p>Once, a hosty.live account:</p>
      <HostyAccountSteps />
      <p>
        <strong>For Claude Code on the web</strong>, once per bot, a session
        that can reach it with your token:
      </p>
      <CloudSessionSetup />
      <p className="hint">
        <strong>In a coding tool on your computer</strong>, connect it to
        hosty.live with the one-line command shown next to your token; the AI
        installs the build tools it needs, or tells you how.
      </p>
    </>
  );
}

function PromptStep({ target }: { target: Target }) {
  return (
    <>
      <p>
        This prompt is filled in for <strong>{target.game.title}</strong>. Paste
        it into the session (on your computer: start your coding tool in an
        empty folder and paste it there):
      </p>
      <CodeBlock code={botPrompt(target)} wrap />
      <p>Finish it with your own description after its last line:</p>
      <CodeBlock
        code={
          'Name: Pencil Pusher\nTwo levels: "Casual" plays a random legal move; "Sharp" takes any\nwin, blocks any threat, and otherwise plays the strongest move it finds.'
        }
      />
      <p className="hint">
        You don't need to understand the prompt. It tells the AI where to find
        the game's rules and its program, how to test, and what not to touch.
        The AI installs the tools it needs, or tells you how.
      </p>
    </>
  );
}

function BuildStep() {
  return (
    <>
      <p>The AI works through it on its own:</p>
      <ol className="tutorial-list">
        <li>
          It reads the game's rules, published by the game itself, and downloads
          the game's program, checking it is exactly the one running live.
        </li>
        <li>It writes the bot and tests its move choices one by one.</li>
        <li>
          It starts a private copy of the game, in the session or on your
          computer, and plays whole games against your bot there, at every
          level, until every game ends cleanly.
        </li>
      </ol>
      <p>
        Ask for changes until it plays the way you want: stronger, weaker, a new
        level. Nothing on the real game changes, and nothing costs anything up
        to here.
      </p>
    </>
  );
}

function GoLiveStep({ target }: { target: Target }) {
  const { game, backend } = target;
  return (
    <>
      <p>
        <strong>Through hosty.live</strong> (from Claude Code on the web or a
        coding tool connected to hosty.live): tell it
      </p>
      <CodeBlock code="Put my bot online through hosty.live and register it as <bot name>." />
      <p>
        with the name players should see. It asks you to approve a deploy
        session in hosty.live (with your passkey; a phone works), creates the
        bot's canister in your account (1.5 TC from your balance), installs
        the bot, and adds it to the game's list of bots in that same session.
        It checks the game lists it and gives you the bot's canister id (also
        in its <code>README.md</code>). Ask for changes any time later: each
        one is tested again and upgrades the same canister, so the bot keeps
        its place in the list.
      </p>
      <p>
        <strong>With icp-cli</strong> (on your own computer, with your own key
        and cycles)
      </p>
      <ol className="tutorial-list">
        <li>
          Create your publishing key (keep it; it is what proves the bot is
          yours), or skip this if you already have an <code>icp</code> identity
          you want to use:
          <CodeBlock
            code={
              "icp identity new my-bot\nicp identity default my-bot\nicp identity principal"
            }
          />
        </li>
        <li>
          Pay for hosting. Programs on the Internet Computer run on prepaid
          “cycles”; about 2–3T cycles (a few dollars) is comfortable for a bot.
          The simplest way is by card at{" "}
          <a href="https://cycle.express/" target="_blank" rel="noreferrer">
            cycle.express
          </a>
          : paste the long address that the last command above printed (your
          “principal”) into its Canister ID field. If you already hold ICP,{" "}
          <code>icp cycles mint --icp 1 -e ic</code> converts it instead. Check
          it arrived:
          <CodeBlock code="icp cycles balance -e ic" />
        </li>
        <li>
          Publish the bot and add it to the game's list of bots, in the project
          folder (the AI left these in its <code>README.md</code> too). Put the
          name players should see in place of <code>&lt;bot name&gt;</code>:
          <CodeBlock
            code={`icp canister link backend ${backend} -e ic --force\nicp deploy bot -e ic\nicp canister call bot register '(principal "${backend}", "<bot name>")' -e ic`}
          />
        </li>
      </ol>
      <p>
        That's it: open{" "}
        <a href={gameUrl(game)} target="_blank" rel="noreferrer">
          {game.title}
        </a>{" "}
        and challenge your bot from its list of bots. Registering again renames
        it; unregistering takes it off the list (through hosty.live, ask your
        AI; with icp-cli):
      </p>
      <CodeBlock
        code={`icp canister call bot unregister '(principal "${backend}")' -e ic`}
      />
    </>
  );
}
