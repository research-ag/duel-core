// A step-by-step guide for a developer who has NOT built a game yet — the
// counterpart to GameFormModal's "register a game you already built" flow.
// Cloud first: a Claude Code session on claude.ai builds and tests the
// game from gamePrompt.ts's prompt and puts it online through hosty.live;
// an agent on the developer's own computer, or icp-cli, are the
// alternatives. Ends with the same registration form the existing flow
// uses.

import { gamePrompt } from "../gamePrompt";
import { CloudSessionSetup, HostyAccountSteps } from "./CloudSessionSetup";
import { CodeBlock } from "./CodeBlock";
import { Wizard } from "./Wizard";

const STEPS = [
  "How it works",
  "hosty.live account",
  "Set up Claude Code",
  "Copy the prompt",
  "Play and go live",
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
  return (
    <Wizard
      kicker="Build a new game"
      title="From your rules to a listed game."
      steps={STEPS}
      onClose={onClose}
      finish={{
        label: "Register your game",
        onClick: onRegister,
        disabled: !isLoggedIn,
      }}
      render={(step) => (
        <>
          {step === 0 && <HowItWorksStep />}
          {step === 1 && <AccountStep />}
          {step === 2 && <SetupStep />}
          {step === 3 && <PromptStep />}
          {step === 4 && <GoLiveStep />}
          {step === 5 && <RegisterStep isLoggedIn={isLoggedIn} />}
        </>
      )}
    />
  );
}

function HowItWorksStep() {
  return (
    <>
      <p>
        Every duel-game-core game is two canisters on the Internet Computer: a
        backend holding the rules and the tables, and a frontend, the page
        players open. You describe the rules; an AI writes and tests both.
      </p>
      <p>
        The simplest way needs nothing on your computer:{" "}
        <a href="https://claude.ai/code" target="_blank" rel="noreferrer">
          Claude Code on the web
        </a>{" "}
        builds and tests the game on Anthropic's servers, and{" "}
        <a href="https://hosty.live/" target="_blank" rel="noreferrer">
          hosty.live
        </a>{" "}
        puts it online: first on free test canisters while you try it and
        ask for changes, then, when you say so, in canisters of your own,
        paid by card from a balance you top up there. You approve every
        paid deploy in the hosty.live tab with your passkey, so nothing is
        spent without you.
      </p>
      <p className="hint">
        Building, testing and trying the game online cost nothing beyond
        your Claude plan. Going live costs about 2.5 TC (a few dollars at
        the time of writing) up front; a live canister then slowly spends
        its cycles on storage and updates, and the dashboard shows when a
        top-up is due.
      </p>
    </>
  );
}

function AccountStep() {
  return (
    <>
      <p>Once, in the browser:</p>
      <HostyAccountSteps />
    </>
  );
}

function SetupStep() {
  return (
    <>
      <p>
        Once per game, so the session has the tools it needs and can reach
        hosty.live with your token:
      </p>
      <CloudSessionSetup />
      <p className="hint">
        Prefer an AI coding tool on your own computer? Install{" "}
        <a
          href="https://github.com/dfinity/icp-cli"
          target="_blank"
          rel="noreferrer"
        >
          icp-cli
        </a>{" "}
        and mops (<code>npm install -g @icp-sdk/icp-cli ic-mops</code>), and
        connect the tool to hosty.live with the one-line command shown next to
        your token. The prompt works the same.
      </p>
    </>
  );
}

function PromptStep() {
  return (
    <>
      <p>Paste this into the session:</p>
      <CodeBlock code={gamePrompt()} wrap />
      <p>Finish it with your rules, in your own words, after its last line:</p>
      <CodeBlock
        code={
          "Rock-paper-scissors with a twist: each player also has one \"well\"\nper game, which beats rock and scissors and loses to paper. First to\nthree round wins takes the match; a tie scores nobody."
        }
      />
      <p className="hint">
        The prompt has the AI install the framework's playbook, build every
        piece of the game, and test it by playing whole games against itself
        before it asks you to look.
      </p>
    </>
  );
}

function GoLiveStep() {
  return (
    <>
      <p>
        When its own tests pass, the AI asks before anything goes online.
        Then:
      </p>
      <ol className="tutorial-list">
        <li>
          It puts the game on two free <strong>cloud engine</strong>{" "}
          canisters in your hosty.live account (no approval, nothing spent),
          installs the backend, uploads the page, and plays a test game
          against them.
        </li>
        <li>
          It gives you the page's address. Open it in two browser tabs, start
          a table in one and join it from the other, and play. Ask for changes
          until it is right: each one is tested again and redeployed to the
          same free canisters. They are for testing: hosty.live may delete
          them, and they cannot be registered here.
        </li>
        <li>
          When the game is right, tell the session to go live. It asks you to
          approve a <strong>deploy session</strong> (open hosty.live, a phone
          works too, and approve it with your passkey), buys the game's two
          canisters from your balance, and deploys the same game there, at
          its permanent address. Later changes upgrade those canisters,
          keeping the address.
        </li>
      </ol>
      <p>
        The game is online but unlisted: only who has its address finds it,
        until you register it in the next step. Note the live{" "}
        <strong>frontend canister id</strong> (the <code>xxxxx-…-cai</code>{" "}
        code), which the registration asks for.
      </p>
      <p className="hint">
        Already have an <code>icp</code> identity and cycles? The game can also
        go online with icp-cli from your own computer;{" "}
        <a href={GOING_LIVE} target="_blank" rel="noreferrer">
          going-live.md
        </a>{" "}
        has both ways, and an AI with the playbook follows it by itself.
      </p>
    </>
  );
}

function RegisterStep({ isLoggedIn }: { isLoggedIn: boolean }) {
  return (
    <>
      <p>
        Last step — list your game on this dashboard so players can find it.
        You'll need the frontend canister id from the previous step, a title,
        a short description, and a banner image.
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
