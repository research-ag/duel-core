// "Make your own frontend": a player's route to their own client for a
// game already listed here, written for someone who knows nothing about
// the Internet Computer or coding. Three ways, picked at the end of "How
// it works": caffeine.ai (chat, builds and hosts the app itself, paid
// plan), hosty.live (a Claude Code cloud session or an agent on the
// computer; a free cloud engine preview first, then a canister paid by
// card), or everything the player's own (icp-cli, their key and cycles).
// Opened from a game's info dialog it starts filled in for that game;
// from the header it starts by picking one.

import { useState } from "react";

import type { Way } from "../cloudSession";
import { frontendPrompt } from "../frontendPrompt";
import type { AggregatorActor, GameView, Target } from "../types";
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

const STEPS = [
  "Pick a game",
  "How it works",
  "Set up",
  "Copy the prompt",
  "Describe and build",
  "Put it online",
  "Register",
] as const;

export function FrontendTutorialWizard({
  initial,
  games,
  loading,
  actor,
  isLoggedIn,
  onClose,
  onRegister,
}: {
  initial: Target | undefined;
  games: GameView[];
  loading: boolean;
  actor: AggregatorActor | undefined;
  isLoggedIn: boolean;
  onClose: () => void;
  onRegister: () => void;
}) {
  const [target, setTarget] = useState(initial);
  const [way, setWay] = useState<Way>();
  return (
    <Wizard
      kicker="Make your own frontend"
      title={
        target
          ? `Your own look for “${target.game.title}”.`
          : "Your own look for a listed game."
      }
      steps={STEPS}
      initialStep={initial ? 1 : 0}
      reachable={!target ? 0 : !way ? 1 : STEPS.length - 1}
      onClose={onClose}
      finish={{
        label: "Register your frontend",
        onClick: onRegister,
        disabled: !isLoggedIn,
      }}
      render={(step, next) => (
        <>
          {step === 0 && (
            <>
              <p>
                Which game do you want your own frontend for? It keeps that
                game's rules and its players; only the look is yours.
              </p>
              <GamePicker
                games={games}
                loading={loading}
                actor={actor}
                purpose="frontend"
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
          {target && way && step === 2 && <SetupStep way={way} />}
          {target && way && step === 3 && (
            <PromptStep target={target} way={way} />
          )}
          {target && way && step === 4 && <BuildStep way={way} />}
          {target && way && step === 5 && <GoLiveStep way={way} />}
          {target && way && step === 6 && (
            <RegisterStep isLoggedIn={isLoggedIn} />
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
  way: Way | undefined;
  onPick: (way: Way) => void;
}) {
  return (
    <>
      <p>
        Every game here is two parts: the game itself, which holds the rules and
        the tables everyone plays at, and a web page that draws it. You can make
        your own page for any listed game — your look, your layout, your words —
        and it plays at the same tables as the original, so your friends and
        theirs meet each other. Nobody needs to touch the game itself.
      </p>
      <p>
        You don't write the page yourself. An AI does, from a prompt we give you
        plus your own description of what you want. Either way the result is
        yours: the page lives at its own address, and you list it here as a game
        of its own, next to the original. Pick your way:
      </p>
      <WayPicker
        picked={way}
        onPick={onPick}
        options={[
          {
            way: "caffeine",
            title: "caffeine.ai",
            note: "A website where you describe an app in a chat. It builds the page, shows it to you, and puts it online when you say so. Needs a paid plan.",
          },
          {
            way: "hosty",
            title: "Claude Code and hosty.live",
            note: "Nothing to install: Claude Code on the web builds and tests the page, shows it to you on a free test canister, and hosty.live puts it online for about a dollar at the time of writing, paid by card. Works from an AI tool on your computer too.",
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

function SetupStep({ way }: { way: Way }) {
  if (way === "hosty") return <HostySetup />;
  if (way === "own") return <OwnSetup />;
  return (
    <p>
      Sign up at{" "}
      <a href="https://caffeine.ai" target="_blank" rel="noreferrer">
        caffeine.ai
      </a>{" "}
      and pick a plan from your profile menu. Building a new app and taking it
      online need a paid plan: at the time of writing the cheapest is “Host” at
      $5 a month (paid by card), which covers building and keeping the page
      online.
    </p>
  );
}

function PromptStep({ target, way }: { target: Target; way: Way }) {
  return (
    <>
      <p>
        This prompt is filled in for <strong>{target.game.title}</strong>. Copy
        it as it is.
      </p>
      <CodeBlock code={frontendPrompt(target, way)} wrap />
      <p className="hint">
        You don't need to understand it. It tells the AI where to find the
        game's rules, how to talk to the game, how to test, and what not to
        touch.
      </p>
    </>
  );
}

function BuildStep({ way }: { way: Way }) {
  return (
    <>
      <p>
        Paste the prompt and finish it with your own description after its last
        line. Say what you want to see, in your own words:
      </p>
      <CodeBlock
        code={
          "Here is the frontend I want:\nA hand-drawn notebook look: the board sketched in pencil on squared\npaper, my marks in blue ink and the opponent's in red, a small doodle\nwhen somebody wins. Big touch targets, it has to work on my phone."
        }
      />
      {way === "caffeine" && (
        <p>
          Start a new app in caffeine.ai and paste it into the chat. If it asks
          questions first, answer them or say “just build it”. It shows you a
          preview of the page when it is done.
        </p>
      )}
      {way === "hosty" && (
        <p>
          Paste it into the session. It tests the page against a private copy of
          the game first, then gives you a preview address: the page in a free
          hosty.live cloud engine canister, for testing only (hosty.live may
          delete it, and it cannot be registered here). On your computer it
          gives you a local address instead.
        </p>
      )}
      {way === "own" && (
        <p>
          Paste it into your coding tool. It tests the page against a private
          copy of the game, then gives you a local address where the page runs
          on your computer.
        </p>
      )}
      <p>
        Open the page in two browser tabs and play a game against yourself:
        start a table in one tab, join it from the other. Ask for changes until
        it is what you had in mind. Nothing has to be paid for up to here
        {way === "caffeine" ? " beyond your plan" : ""}.
      </p>
      {way !== "own" && (
        <p className="hint">
          The preview plays the real game, so start every table with an access
          code (the prompt tells the AI the same) and other players won't wander
          in.
        </p>
      )}
    </>
  );
}

function GoLiveStep({ way }: { way: Way }) {
  if (way === "caffeine")
    return (
      <p>
        Click <strong>Go live</strong> (if you can't find it, ask the chat how
        to put the app online). It puts the page online at a permanent address
        and keeps it there as long as your plan is active. Then ask the chat:
        “What is the address of my live app, and its frontend canister id?” —
        write both down for the next step.
      </p>
    );
  if (way === "own")
    return (
      <>
        <p>In a terminal of your own:</p>
        <ol className="tutorial-list">
          <IcpIdentitySteps cycles="2T for the page's canister (a few dollars) is enough" />
        </ol>
        <p>Then tell the AI:</p>
        <CodeBlock code="Put my frontend online with icp-cli." />
        <p>
          It deploys the page, pointed at the game, and gives you its address
          and the canister id (the <code>xxxxx-…-cai</code> code). Write both
          down for the next step. Later changes are another deploy into the same
          canister.
        </p>
      </>
    );
  return (
    <>
      <HostyCycles cost="a page costs 0.84 TC, about a dollar" />
      <p>Then tell the session:</p>
      <CodeBlock code="Put my frontend live on mainnet through hosty.live (buy its canister)." />
      <p>
        It asks you to approve a deploy session, buys the page's canister from
        your balance, uploads the page pointed at the game, and gives you its
        address and the canister id (the <code>xxxxx-…-cai</code> code). Write
        both down for the next step. The free test page does not count: it
        cannot be registered. Later changes are another upload into the same
        canister; your own web address (a custom domain) can be set up from the
        canister's page in hosty.live.
      </p>
      <DeploySessionNote />
    </>
  );
}

function RegisterStep({ isLoggedIn }: { isLoggedIn: boolean }) {
  return (
    <>
      <p>
        Last step: list your page here as an entry of its own, next to the
        original. The form asks for your page's <strong>canister id</strong>{" "}
        (the <code>xxxxx-…-cai</code> code from the previous step), a title that
        tells the two apart, a short description, and a banner image. If your
        page has its own web address (caffeine.ai gives it one; hosty.live can
        attach yours), put that in the “custom domain” field so players open it
        there.
      </p>
      {isLoggedIn ? (
        <p>
          Click "Register your frontend" below to open the registration form.
        </p>
      ) : (
        <p className="error">
          Log in with Internet Identity first (top right), then come back here
          to register.
        </p>
      )}
    </>
  );
}
