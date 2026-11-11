// A step-by-step guide for a developer who has NOT built a game yet — the
// counterpart to GameFormModal's "register a game you already built" flow.
// Two ways, picked at the end of "How it works": through hosty.live (a
// Claude Code cloud session or an agent on the computer builds and tests
// the game from gamePrompt.ts's prompt, free cloud engine canisters for
// the first look, bought ones to go live), or everything the developer's
// own (icp-cli, their key and cycles). Ends with the same registration
// form the existing flow uses.

import { useState } from "react";

import type { Way } from "../cloudSession";
import { gamePrompt } from "../gamePrompt";
import {
  DeploySessionNote,
  HostyCycles,
  HostySetup,
  IcpIdentitySteps,
  OwnSetup,
} from "./CloudSessionSetup";
import { CodeBlock } from "./CodeBlock";
import { Wizard } from "./Wizard";
import { WayPicker } from "./WayPicker";

type GameWay = Exclude<Way, "caffeine">;

const STEPS = [
  "How it works",
  "Set up",
  "Copy the prompt",
  "Try it",
  "Go live",
  "Register",
] as const;

const GOING_LIVE =
  "https://github.com/research-ag/duel-core/blob/main/skills/duel-game-core/references/going-live.md";

export function TutorialWizard({
  isLoggedIn,
  onClose,
  onRegister,
}: {
  isLoggedIn: boolean;
  onClose: () => void;
  onRegister: () => void;
}) {
  const [way, setWay] = useState<GameWay>();
  return (
    <Wizard
      kicker="Build a new game"
      title="From your rules to a listed game."
      steps={STEPS}
      reachable={way ? STEPS.length - 1 : 0}
      onClose={onClose}
      finish={{
        label: "Register your game",
        onClick: onRegister,
        disabled: !isLoggedIn,
      }}
      render={(step, next) => (
        <>
          {step === 0 && (
            <HowItWorksStep
              way={way}
              onPick={(w) => {
                setWay(w);
                next();
              }}
            />
          )}
          {way &&
            step === 1 &&
            (way === "hosty" ? <HostySetup /> : <OwnSetup />)}
          {way && step === 2 && <PromptStep way={way} />}
          {way && step === 3 && <TryStep way={way} />}
          {way && step === 4 && <GoLiveStep way={way} />}
          {way && step === 5 && <RegisterStep isLoggedIn={isLoggedIn} />}
        </>
      )}
    />
  );
}

function HowItWorksStep({
  way,
  onPick,
}: {
  way: GameWay | undefined;
  onPick: (way: GameWay) => void;
}) {
  return (
    <>
      <p>
        Every duel-game-core game is two canisters on the Internet Computer: a
        backend holding the rules and the tables, and a frontend, the page
        players open. You describe the rules; an AI writes and tests both.
      </p>
      <p>Pick your way:</p>
      <WayPicker
        picked={way}
        onPick={onPick}
        options={[
          {
            way: "hosty",
            title: "Through hosty.live",
            note: "Nothing to install: Claude Code on the web builds the game, you try it on free test canisters, and it goes live for a few dollars, paid by card. Works from an AI tool on your computer too.",
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

function PromptStep({ way }: { way: GameWay }) {
  return (
    <>
      <p>
        Paste this into the session{way === "own" ? " (your coding tool)" : ""}:
      </p>
      <CodeBlock code={gamePrompt(way)} wrap />
      <p>Finish it with your rules, in your own words, after its last line:</p>
      <CodeBlock
        code={
          'Rock-paper-scissors with a twist: each player also has one "well"\nper game, which beats rock and scissors and loses to paper. First to\nthree round wins takes the match; a tie scores nobody.'
        }
      />
      <p className="hint">
        The prompt points the AI at the framework's playbook, which has it build
        every piece of the game and test it by playing whole games against
        itself before it asks you to look.
      </p>
    </>
  );
}

function TryStep({ way }: { way: GameWay }) {
  return (
    <>
      {way === "hosty" ? (
        <p>
          When its own tests pass, the AI puts the game on free{" "}
          <strong>cloud engine</strong> canisters in your hosty.live account (no
          approval, nothing spent), plays a test game against them, and gives
          you the page's address. On your computer it gives you a local address
          instead.
        </p>
      ) : (
        <p>
          When its own tests pass, the AI gives you the local address where the
          game runs on your computer.
        </p>
      )}
      <p>
        Open it in two browser tabs, start a table in one and join it from the
        other, and play. Ask for changes until it is right: each one is tested
        again and redeployed to the same place.
      </p>
      {way === "hosty" && (
        <p className="hint">
          The free canisters are for testing: hosty.live may delete them, and
          they cannot be registered here.
        </p>
      )}
    </>
  );
}

function GoLiveStep({ way }: { way: GameWay }) {
  return (
    <>
      {way === "hosty" ? (
        <>
          <HostyCycles cost="A game costs about 2.5 TC (a few dollars), about 4 TC with a bot." />
          <p>
            Then tell the session the game goes live on mainnet. It asks you to
            approve a deploy session, buys the game's canisters from your
            balance, and deploys the same game there, at its permanent address.
            Later changes upgrade those canisters, keeping the address.
          </p>
          <DeploySessionNote />
        </>
      ) : (
        <>
          <p>In a terminal of your own:</p>
          <ol className="tutorial-list">
            <IcpIdentitySteps cycles="about 5T (a few dollars) is comfortable for a game, 7T with a bot" />
          </ol>
          <p>
            Then tell the AI the game goes live. It deploys the backend and the
            page with icp-cli and gives you the address. Later changes upgrade
            the same canisters, keeping the address.{" "}
            <a href={GOING_LIVE} target="_blank" rel="noreferrer">
              going-live.md
            </a>{" "}
            has the details.
          </p>
        </>
      )}
      <p>
        The game is online but unlisted: only who has its address finds it,
        until you register it in the next step. Note the live{" "}
        <strong>frontend canister id</strong> (the <code>xxxxx-…-cai</code>{" "}
        code), which the registration asks for.
      </p>
    </>
  );
}

function RegisterStep({ isLoggedIn }: { isLoggedIn: boolean }) {
  return (
    <>
      <p>
        Last step — list your game on this dashboard so players can find it.
        You'll need the frontend canister id from the previous step, a title, a
        short description, and a banner image.
      </p>
      {isLoggedIn ? (
        <p>Click "Register your game" below to open the registration form.</p>
      ) : (
        <p className="error">
          Log in with Internet Identity first (top right), then come back here
          to register.
        </p>
      )}
    </>
  );
}
