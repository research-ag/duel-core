// "Build a bot": a canister player for a game already listed here, built
// by an AI coding agent from botPrompt.ts's prompt. Two ways, picked at
// the end of "How it works": through hosty.live (a Claude Code cloud
// session first, or an agent on the computer) or everything the
// developer's own (icp-cli, their key and cycles). The agent tests it
// against a local copy of the game made from the module the backend runs,
// then puts it online and has it register itself with the game (a bot is
// never listed on this dashboard). Opened from a game's info dialog it starts filled in
// for that game; from the header it starts by picking one.

import { useState } from "react";

import { botPrompt } from "../botPrompt";
import type { Way } from "../cloudSession";
import type { AggregatorActor, GameView, Target } from "../types";
import { gameUrl } from "../types";
import {
  DeploySessionNote,
  HostyCycles,
  HostySetup,
  IcpIdentitySteps,
  OwnSetup,
} from "./CloudSessionSetup";
import { CodeBlock } from "./CodeBlock";
import { GamePicker } from "./GamePicker";
import { Wizard } from "./Wizard";
import { WayPicker } from "./WayPicker";

type BotWay = Exclude<Way, "caffeine">;

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
  const [way, setWay] = useState<BotWay>();
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
      reachable={!target ? 0 : !way ? 1 : STEPS.length - 1}
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
          {target && step === 1 && (
            <HowItWorksStep
              way={way}
              onPick={(w) => {
                setWay(w);
                next();
              }}
            />
          )}
          {target &&
            way &&
            step === 2 &&
            (way === "hosty" ? <HostySetup /> : <OwnSetup />)}
          {target && way && step === 3 && (
            <PromptStep target={target} way={way} />
          )}
          {target && way && step === 4 && <BuildStep way={way} />}
          {target && way && step === 5 && (
            <GoLiveStep target={target} way={way} />
          )}
        </>
      )}
    />
  );
}

function HowItWorksStep({
  way,
  onPick,
}: {
  way: BotWay | undefined;
  onPick: (way: BotWay) => void;
}) {
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
        give you plus your own description of how the bot should play. It tests
        the bot against a private copy of the game before anything goes online,
        so a browser-based app builder can't make one. Pick your way:
      </p>
      <WayPicker
        picked={way}
        onPick={onPick}
        options={[
          {
            way: "hosty",
            title: "Through hosty.live",
            note: "Nothing to install: Claude Code on the web builds and tests the bot, and hosty.live puts it online for 1.5 TC (a few dollars), paid by card. Works from an AI tool on your computer too.",
          },
          {
            way: "own",
            title: "All your own, with icp-cli",
            note: "An AI tool on your computer, your own key and cycles, no hosty.live. For people who already work with icp-cli.",
          },
        ]}
      />
    </>
  );
}

function PromptStep({ target, way }: { target: Target; way: BotWay }) {
  return (
    <>
      <p>
        This prompt is filled in for <strong>{target.game.title}</strong>. Paste
        it into the session (on your computer: into your coding tool):
      </p>
      <CodeBlock code={botPrompt(target, way)} wrap />
      <p>Finish it with your own description after its last line:</p>
      <CodeBlock
        code={
          'Name: Pencil Pusher\nTwo levels: "Casual" plays a random legal move; "Sharp" takes any\nwin, blocks any threat, and otherwise plays the strongest move it finds.'
        }
      />
      <p className="hint">
        You don't need to understand the prompt. It points the AI at the game's
        rules and at the framework's playbook for exactly this task: where the
        game's program is, how to test, and what not to touch. The AI installs
        the tools it needs, or tells you how.
      </p>
    </>
  );
}

function BuildStep({ way }: { way: BotWay }) {
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
        {way === "hosty" &&
          " To watch it yourself before paying, ask for a free online try-out: a temporary copy of the game on hosty.live's cloud engine with your bot beside it (an empty copy, not the real game), or your bot in a free 24-hour canister playing the real game."}
      </p>
    </>
  );
}

function GoLiveStep({ target, way }: { target: Target; way: BotWay }) {
  const { game, backend } = target;
  const unregister = `icp canister call bot unregister '(principal "${backend}")' -e ic`;
  return (
    <>
      {way === "hosty" ? (
        <>
          <p>
            Before paying anything, ask the session which subnet the game is on.
            A bot must sit on its game's subnet, and hosty.live creates every
            canister on one subnet. If the game is elsewhere, the bot goes
            online from your computer with icp-cli, your own key and cycles
            instead: the session gives you those steps, and you skip the top-up
            below.
          </p>
          <HostyCycles cost="A bot's canister costs 1.5 TC (a few dollars)." />
          <p>Then tell the session</p>
          <CodeBlock code="Put my bot live on mainnet through hosty.live (buy its canister) and register it as <bot name>." />
          <p>
            with the name players should see. It asks you to approve a deploy
            session, buys the bot's canister from your balance, installs the
            bot, and adds it to the game's list of bots in that same session. It
            checks the game lists it and gives you the bot's canister id (also
            in its <code>README.md</code>). Ask for changes any time later: each
            one is tested again and upgrades the same canister, so the bot keeps
            its place in the list.
          </p>
          <DeploySessionNote />
        </>
      ) : (
        <ol className="tutorial-list">
          <IcpIdentitySteps cycles="about 2–3T (a few dollars) is comfortable for a bot" />
          <li>
            Publish the bot and add it to the game's list of bots, in the
            project folder (the AI left these in its <code>README.md</code>{" "}
            too). First find the game's subnet: the bot goes on the same one, so
            its moves stay quick.
            <CodeBlock
              code={`curl -sf https://ic-api.internetcomputer.org/api/v3/canisters/${backend} | grep -o '"subnet_id":"[^"]*"' | cut -d'"' -f4`}
            />
            If it prints nothing, stop here and ask the AI. Otherwise put the
            subnet id it printed in place of{" "}
            <code>&lt;the game's subnet&gt;</code> below, and the name players
            should see in place of <code>&lt;bot name&gt;</code>:
            <CodeBlock
              code={`icp canister link backend ${backend} -e ic --force\nicp deploy bot -e ic --subnet <the game's subnet>\nicp canister call bot register '(principal "${backend}", "<bot name>")' -e ic`}
            />
            Later upgrades run <code>icp deploy bot -e ic</code> again, without{" "}
            <code>--subnet</code>. If the project folder lost its record of the
            bot (<code>.icp/data/mappings/ic.ids.json</code> has no{" "}
            <code>bot</code> entry), link the bot's canister id first:
            <CodeBlock code="icp canister link bot <bot id> -e ic" />
          </li>
        </ol>
      )}
      <p>
        That's it: open{" "}
        <a href={gameUrl(game)} target="_blank" rel="noreferrer">
          {game.title}
        </a>{" "}
        and challenge your bot from its list of bots. Registering again renames
        it; unregistering takes it off the list
        {way === "hosty" ? " (ask your AI)." : ":"}
      </p>
      {way === "own" && <CodeBlock code={unregister} />}
    </>
  );
}
