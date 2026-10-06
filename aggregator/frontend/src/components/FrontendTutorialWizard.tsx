// "Make own frontend": a player's route to their own client for a game
// already listed here, written for someone who knows nothing about the
// Internet Computer or coding. Two ways through: caffeine.ai (chat,
// builds and hosts the app itself, paid plan) or an AI coding agent on
// their own computer (free tools, pays hosting directly). `game` is the
// card the wizard was opened from, or undefined from the header.

import type { GameView } from "../types";
import { frontendPrompt } from "../frontendPrompt";
import { CodeBlock } from "./CodeBlock";
import { Wizard } from "./Wizard";

const STEPS = [
  "How it works",
  "Copy the prompt",
  "Describe and build",
  "Put it online",
  "Register",
] as const;

export function FrontendTutorialWizard({
  game,
  isLoggedIn,
  onClose,
  onRegister,
}: {
  game: GameView | undefined;
  isLoggedIn: boolean;
  onClose: () => void;
  onRegister: () => void;
}) {
  return (
    <Wizard
      kicker="Make own frontend"
      title={
        game
          ? `Your own look for “${game.title}”.`
          : "Your own look for any listed game."
      }
      steps={STEPS}
      onClose={onClose}
      finish={{
        label: "Register your frontend",
        onClick: onRegister,
        disabled: !isLoggedIn,
      }}
      render={(step) => (
        <>
          {step === 0 && <HowItWorksStep />}
          {step === 1 && <PromptStep game={game} />}
          {step === 2 && <BuildStep />}
          {step === 3 && <GoLiveStep />}
          {step === 4 && <RegisterStep isLoggedIn={isLoggedIn} />}
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
          subscription); putting the page online then takes a few one-time
          steps, explained in step 4. Choose this if you already use one of
          these tools.
        </li>
      </ol>
      <p className="hint">
        Either way the result is yours: the page lives at its own address, and
        you list it here as a game of its own, next to the original.
      </p>
    </>
  );
}

function PromptStep({ game }: { game: GameView | undefined }) {
  return (
    <>
      {game ? (
        <p>
          This prompt is filled in for <strong>{game.title}</strong>. Copy it as
          it is.
        </p>
      ) : (
        <p>
          Replace the title and the address in the first lines with the game you
          picked, or open this guide from a game's own{" "}
          <strong>Make own frontend</strong> button to have them filled in.
        </p>
      )}
      <CodeBlock code={frontendPrompt(game)} wrap />
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
        While you test, the page talks to the real game; the prompt tells the
        AI to use tables with an access code so other players don't wander in.
        (If a coding tool finds <code>icp-cli</code> from step 4 already
        installed, it runs a private copy of the game on your computer instead
        and leaves the real one alone.)
      </p>
    </>
  );
}

function GoLiveStep() {
  return (
    <>
      <ol className="tutorial-list">
        <li>
          <strong>In caffeine.ai:</strong> the AI ends with the steps to
          follow; in short, click <strong>Go live</strong>. It puts the page
          online at a permanent address and keeps it there as long as your plan
          is active. Then ask the chat: “What is the address of my live app,
          and its frontend canister id?” — write both down for the next step.
        </li>
        <li>
          <strong>From your own computer</strong>, three one-time things, then
          two commands. The AI tool can walk you through each of them if you
          paste these instructions to it.
          <ol className="tutorial-list">
            <li>
              Install <code>icp-cli</code>, the program that publishes to the
              Internet Computer — see the{" "}
              <a
                href="https://github.com/dfinity/icp-cli"
                target="_blank"
                rel="noreferrer"
              >
                icp-cli project
              </a>{" "}
              for your system — and create your publishing key (keep it; it is
              what proves the page is yours):
              <CodeBlock
                code={
                  "icp identity new my-frontend\nicp identity default my-frontend\nicp identity principal"
                }
              />
            </li>
            <li>
              Pay for hosting. Pages on the Internet Computer run on prepaid
              “cycles”; about 1–2T cycles (a few dollars) is comfortable for a
              frontend. The simplest way is by card at{" "}
              <a href="https://cycle.express/" target="_blank" rel="noreferrer">
                cycle.express
              </a>
              : paste the long address that the last command above printed (your
              “principal”) into its Canister ID field. Check it arrived:
              <CodeBlock code="icp cycles balance -e ic" />
            </li>
            <li>
              Publish. The AI left these commands in the project's{" "}
              <code>README.md</code> with the game's id filled in; run them in
              the project folder:
              <CodeBlock
                code={
                  "icp canister link backend <game-backend-id> -e ic\nicp deploy frontend -e ic"
                }
              />
              The first line points your page at the real game. Then get your
              page's canister id for the next step:
              <CodeBlock code="icp canister status frontend -e ic -i" />
              Your page is at <code>https://&lt;that id&gt;.icp0.io</code>.
            </li>
          </ol>
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
        page has its own web address (caffeine.ai gives it one), put that in the
        “custom domain” field so players open it there.
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
