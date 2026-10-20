// "Make your own frontend": a player's route to their own client for a
// game already listed here, written for someone who knows nothing about
// the Internet Computer or coding. Two ways through: caffeine.ai (chat,
// builds and hosts the app itself, paid plan) or an AI coding agent on
// their own computer (free tools; the page goes online through
// hosty.live, in a canister paid by card). Opened from a
// game's info dialog it starts filled in for that game; from the header
// it starts by picking one.

import { useState } from "react";

import { frontendPrompt } from "../frontendPrompt";
import type { AggregatorActor, GameView, Target } from "../types";
import { CodeBlock } from "./CodeBlock";
import { GamePicker } from "./GamePicker";
import { Wizard } from "./Wizard";

const STEPS = [
  "Pick a game",
  "How it works",
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
      reachable={target ? STEPS.length - 1 : 0}
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
          {target && step === 1 && <HowItWorksStep />}
          {target && step === 2 && <PromptStep target={target} />}
          {target && step === 3 && <BuildStep />}
          {target && step === 4 && <GoLiveStep backend={target.backend} />}
          {target && step === 5 && <RegisterStep isLoggedIn={isLoggedIn} />}
        </>
      )}
    />
  );
}

function HowItWorksStep() {
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
        plus your own description of what you want. Pick where that AI runs:
      </p>
      <ol className="tutorial-list">
        <li>
          <strong>
            <a href="https://caffeine.ai" target="_blank" rel="noreferrer">
              caffeine.ai
            </a>{" "}
            — nothing to install.
          </strong>{" "}
          A website where you describe an app in a chat; it builds the page,
          shows it to you, and puts it online when you say so. Building a new
          app and taking it online need a paid plan: at the time of writing the
          cheapest is “Host” at $5 a month (paid by card), which covers building
          and keeping the page online. Sign up and pick a plan from your profile
          menu.
        </li>
        <li>
          <strong>An AI coding tool on your own computer</strong> — Claude Code,
          Cursor, Codex and the like. Free to build with (beyond the tool's own
          subscription); the page then goes online through{" "}
          <a href="https://hosty.live" target="_blank" rel="noreferrer">
            hosty.live
          </a>
          , for about a dollar by card, as step 5 explains. Choose this if you
          already use one of these tools.
        </li>
      </ol>
      <p className="hint">
        Either way the result is yours: the page lives at its own address, and
        you list it here as a game of its own, next to the original.
      </p>
    </>
  );
}

function PromptStep({ target }: { target: Target }) {
  return (
    <>
      <p>
        This prompt is filled in for <strong>{target.game.title}</strong>. Copy
        it as it is.
      </p>
      <CodeBlock code={frontendPrompt(target)} wrap />
      <p className="hint">
        You don't need to understand it. It tells the AI where to find the
        game's rules, how to talk to the game, how to test, and what not to
        touch. It works both in caffeine.ai and in a coding tool.
      </p>
    </>
  );
}

function BuildStep() {
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
      <ol className="tutorial-list">
        <li>
          <strong>In caffeine.ai:</strong> start a new app and paste it into the
          chat. If it asks questions first, answer them or say “just build it”.
          It shows you a preview of the page when it is done.
        </li>
        <li>
          <strong>In a coding tool:</strong> make an empty folder, start the
          tool in it, paste the prompt. When it is done it gives you a local
          address where the page is running on your computer.
        </li>
      </ol>
      <p>
        Open the page in two browser tabs and play a game against yourself:
        start a table in one tab, join it from the other. Ask for changes until
        it is what you had in mind. Nothing has to be installed or paid for up
        to here.
      </p>
      <p className="hint">
        While you test, the page talks to the real game; the prompt tells the AI
        to use tables with an access code so other players don't wander in. (A
        coding tool connected to hosty.live, see the next step, tests against a
        private copy of the game in a free 24-hour canister instead and leaves
        the real one alone.)
      </p>
    </>
  );
}

function GoLiveStep({ backend }: { backend: string }) {
  return (
    <>
      <ol className="tutorial-list">
        <li>
          <strong>In caffeine.ai:</strong> click <strong>Go live</strong> (if
          you can't find it, ask the chat how to put the app online). It puts
          the page online at a permanent address and keeps it there as long as
          your plan is active. Then ask the chat: “What is the address of my
          live app, and its frontend canister id?” — write both down for the
          next step.
        </li>
        <li>
          <strong>From your own computer</strong>, through{" "}
          <a href="https://hosty.live" target="_blank" rel="noreferrer">
            hosty.live
          </a>
          , a website that puts a finished page online for you.
          <ol className="tutorial-list">
            <li>
              Sign in at hosty.live. It uses Internet Identity: a passkey on
              your device, no password and no email.
            </li>
            <li>
              Get a space for the page (a “canister”):{" "}
              <strong>Canisters</strong> → <strong>Create New Canister</strong>,
              paid from the <strong>Cycles</strong> balance that you top up by
              card (about a dollar at the time of writing). The free rental
              offered next to it is wiped after 24 hours, so it is only good for
              trying things out.
            </li>
            <li>
              Tell the canister which game it plays: on its page, under{" "}
              <strong>Canister environment variables</strong>, click{" "}
              <strong>Add variable</strong> and enter
              <CodeBlock code={`PUBLIC_CANISTER_ID:backend`} />
              as the name and
              <CodeBlock code={backend} />
              as the value, then <strong>Save and publish</strong>. If your AI
              tool puts the page online for you (next step), it can set this
              itself with the upload.
            </li>
            <li>
              Let your AI tool publish for you: <strong>Settings</strong> →{" "}
              <strong>AI agent access</strong> → create a token. The page shows
              a one-line command that connects your tool to hosty.live; run it,
              restart the tool, then tell it:
              <CodeBlock
                code={`Put my frontend online through hosty.live into canister <canister-id>.`}
              />
              It builds the page, uploads it, and gives you the page's web
              address. Write it and the canister id (the{" "}
              <code>xxxxx-…-cai</code> code) down for the next step.
            </li>
            <li>
              Without the tool: in hosty.live open the canister →{" "}
              <strong>Deploy</strong> → <strong>ZIP Upload</strong>, upload a
              zip of the built <code>dist</code> folder (your tool's README says
              how to make it) with the already-built option on, output directory{" "}
              <code>dist</code>. The canister's page shows the address.
            </li>
          </ol>
          Later changes are another upload. Your own web address (a custom
          domain) can be set up from the canister's page.
        </li>
      </ol>
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
