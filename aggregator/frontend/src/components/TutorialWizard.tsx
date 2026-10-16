// A step-by-step guide for a developer who has NOT built a game yet — the
// counterpart to GameFormModal's "register a game you already built" flow.
// This is a browser page: it can't run commands on the developer's machine,
// so each step is a short explanation plus copy-pasteable commands for their
// own terminal, ending with the same registration form the existing flow
// uses.

import { useState } from "react";

import { CodeBlock } from "./CodeBlock";
import { Wizard } from "./Wizard";

const STEPS = [
  "Prerequisites",
  "Project setup",
  "Generate the skeleton",
  "Deploy to mainnet",
  "Register",
] as const;

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
      title="From empty directory to listed game."
      steps={STEPS}
      onClose={onClose}
      finish={{
        label: "Register your game",
        onClick: onRegister,
        disabled: !isLoggedIn,
      }}
      render={(step) => (
        <>
          {step === 0 && <PrerequisitesStep />}
          {step === 1 && <ProjectSetupStep />}
          {step === 2 && <SkeletonStep />}
          {step === 3 && <DeployStep />}
          {step === 4 && <RegisterStep isLoggedIn={isLoggedIn} />}
        </>
      )}
    />
  );
}

function PrerequisitesStep() {
  return (
    <>
      <p>
        Every duel-game-core game is two canisters (backend + frontend) on the
        Internet Computer. You build and test them on your own machine first;
        nothing costs anything until you put the game online in the last steps.
      </p>
      <ol className="tutorial-list">
        <li>
          Install <code>icp-cli</code>, the tool that builds the game and runs
          a private copy of the Internet Computer to test it on — see the{" "}
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
          Sign in at{" "}
          <a href="https://hosty.live/" target="_blank" rel="noreferrer">
            hosty.live
          </a>{" "}
          with Internet Identity (a passkey; no password, no email). Whichever
          way your game goes online, its module is published in hosty.live's
          module store, so others can build their own frontends and bots for
          it.
        </li>
      </ol>
    </>
  );
}

function ProjectSetupStep() {
  return (
    <>
      <p>
        Create a fresh directory for your game — this is where all its code will
        live.
      </p>
      <CodeBlock code={"mkdir my-game && cd my-game\ngit init"} />
      <p className="hint">
        Optional: for a remote backup (or so an AI assistant can push progress),
        create an empty repository on your git host's website (e.g. GitHub),
        then link it as `origin` and push:
      </p>
      <CodeBlock
        code={"git remote add origin <your-repo-url>\ngit push -u origin main"}
      />
    </>
  );
}

function SkeletonStep() {
  return (
    <>
      <p>
        A full game is six pieces of code — a rules module, a host actor, tests,
        a frontend plugin, and deploy config. You don't have to write any of it
        by hand.
      </p>
      <p>
        The whole workflow — copy-and-fill templates for every file, step by
        step — is written down here:
      </p>
      <p>
        <a
          href="https://github.com/research-ag/duel-core/blob/main/skills/duel-game-core/SKILL.md"
          target="_blank"
          rel="noreferrer"
        >
          skills/duel-game-core/SKILL.md
        </a>
      </p>
      <p>
        <strong>Shortcut for agentic development</strong>
      </p>
      <p>
        Working with an AI coding assistant (e.g. Claude Code)? Install that
        same playbook as a skill in your new project directory instead of
        reading it yourself:
      </p>
      <CodeBlock code="npx skills add research-ag/duel-core --skill duel-game-core" />
      <p className="hint">
        Then just ask it something like: "Build me a duel-game-core game where
        players ...". The skill walks the assistant through the whole
        rules/host/tests/plugin/config workflow from your rules description
        alone.
      </p>
    </>
  );
}

function DeployStep() {
  return (
    <>
      <p>Once your skeleton is filled in, build and test locally first:</p>
      <CodeBlock
        code={
          "mops install\nmops test\n\ncd frontend && npm install --legacy-peer-deps && npm run build && cd .."
        }
      />
      <p>
        Then put it on the Internet Computer mainnet — this is the step that
        costs money. Pick one way and keep the whole game on it; the
        step-by-step procedure for both is{" "}
        <a
          href="https://github.com/research-ag/duel-core/blob/main/skills/duel-game-core/references/going-live.md"
          target="_blank"
          rel="noreferrer"
        >
          going-live.md
        </a>
        , which an AI assistant with the skill follows by itself.
      </p>
      <p>
        <strong>Through hosty.live</strong> (simplest; paid by card, no keys
        on your machine)
      </p>
      <ol className="tutorial-list">
        <li>
          In hosty.live, <strong>Canisters</strong> →{" "}
          <strong>Create New Canister</strong> twice: a{" "}
          <strong>Backend</strong> and a <strong>Frontend</strong> (0.84 TC
          each, about a dollar at the time of writing, from a balance you top
          up by card under <strong>Cycles</strong>).
        </li>
        <li>
          <strong>Settings</strong> → <strong>AI agent access</strong> →
          create a token, and connect your AI assistant with the command shown
          next to it. Then ask it to put the game online through hosty.live:
          it builds the backend, installs it after you approve a deploy
          session in the hosty.live tab, points the page at the backend, and
          uploads the page.
        </li>
      </ol>
      <p>
        <strong>With icp-cli</strong> (your own key and cycles)
      </p>
      <ol className="tutorial-list">
        <li>
          Create a deploy key (keep it safe, it controls your canisters), or
          use an <code>icp</code> identity you already have:
          <CodeBlock
            code={
              "icp identity new my-game\nicp identity default my-game\nicp identity principal"
            }
          />
        </li>
        <li>
          Get about 5T cycles for the two canisters. If you hold ICP,{" "}
          <code>icp cycles mint --icp 2 -e ic</code> converts it; otherwise buy
          them by card at{" "}
          <a href="https://cycle.express/" target="_blank" rel="noreferrer">
            cycle.express
          </a>
          , pasting your principal (from above) into its{" "}
          <strong>Canister ID</strong> field, or open this URL with it in place
          of <code>&lt;principal&gt;</code>:
          <CodeBlock code="https://cycle.express/?to=<principal>" />
          Check it arrived:
          <CodeBlock code="icp cycles balance -e ic" />
        </li>
        <li>
          In hosty.live, <strong>Settings</strong> →{" "}
          <strong>AI agent access</strong> → create a token, and keep it where
          only you can read it; the deploy uses it to publish the backend's
          module:
          <CodeBlock
            code={
              "mkdir -p ~/.config/hosty && printf %s 'hl_...' > ~/.config/hosty/token && chmod 600 ~/.config/hosty/token"
            }
          />
        </li>
        <li>
          Deploy both canisters:
          <CodeBlock code="HOSTY_TOKEN=$(cat ~/.config/hosty/token) icp deploy -e ic -y" />
        </li>
      </ol>
      <p>
        Either way, note the <strong>frontend canister id</strong> — the
        registration form in the next step needs it, and its page is the
        game's URL you share with players.
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
