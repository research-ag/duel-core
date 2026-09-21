// A step-by-step guide for a developer who has NOT built a game yet — the
// counterpart to GameFormModal's "register a game you already built" flow.
// This is a browser page: it can't run commands on the developer's machine,
// so each step is a short explanation plus copy-pasteable commands for their
// own terminal, ending with the same registration form the existing flow
// uses.

import { useState } from "react";

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
  const [step, setStep] = useState(0);
  const last = step === STEPS.length - 1;

  return (
    <div className="modal-backdrop">
      <div className="modal tutorial-modal">
        <h2>
          Build a new game — step {step + 1} of {STEPS.length}: {STEPS[step]}
        </h2>
        <div className="tutorial-steps">
          {STEPS.map((s, i) => (
            <span key={s} className={`dot${i <= step ? " done" : ""}`} />
          ))}
        </div>

        <div className="tutorial-body">
          {step === 0 && <PrerequisitesStep />}
          {step === 1 && <ProjectSetupStep />}
          {step === 2 && <SkeletonStep />}
          {step === 3 && <DeployStep />}
          {step === 4 && <RegisterStep isLoggedIn={isLoggedIn} />}
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
          <span className="spacer" />
          {step > 0 && (
            <button type="button" onClick={() => setStep((s) => s - 1)}>
              Back
            </button>
          )}
          {!last && (
            <button type="button" className="primary" onClick={() => setStep((s) => s + 1)}>
              Next
            </button>
          )}
          {last && (
            <button type="button" className="primary" onClick={onRegister} disabled={!isLoggedIn}>
              Register your game
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — nothing else to do.
    }
  }

  return (
    <div className="code-block">
      <button type="button" className="copy" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>{code}</pre>
    </div>
  );
}

function PrerequisitesStep() {
  return (
    <>
      <p>
        Every duel-game-core game deploys as two canisters (backend + frontend) on the Internet
        Computer. Before writing any code, make sure your machine can create and deploy them.
      </p>
      <ol className="tutorial-list">
        <li>
          Install <code>icp-cli</code>, the tool used to build and deploy — see the{" "}
          <a href="https://github.com/dfinity/icp-cli" target="_blank" rel="noreferrer">
            icp-cli project
          </a>{" "}
          for install instructions. Verify it's on your PATH:
          <CodeBlock code="icp --version" />
        </li>
        <li>
          Already have an identity you want to deploy with? Skip this — it's optional. Otherwise,
          check what you have and switch to the right one:
          <CodeBlock code={"icp identity list       # your existing identities\nicp identity default    # which one is currently selected"} />
          Or create a fresh one and switch to it (this is your deploy key — keep it safe, it
          controls your canisters):
          <CodeBlock code={"icp identity new my-game\nicp identity default my-game"} />
          <p className="hint">
            By default `icp identity new` stores the private key in your OS's own secure keyring
            (Keychain / Secret Service / Credential Manager) — not a plaintext file on disk.
          </p>
        </li>
        <li>
          Get enough cycles to create and deploy 2 canisters, with some margin — aim for at least
          ~4–6T cycles to start comfortably. Check what you already have:
          <CodeBlock code="icp cycles balance -e ic" />
          If that's already enough, skip ahead. Otherwise, get your principal — the address
          cycles attach to:
          <CodeBlock code="icp identity principal" />
          Already hold some ICP? Convert it directly:
          <CodeBlock code="icp cycles mint --icp 2 -e ic" />
          Don't have any ICP? The easiest option is buying cycles straight with a credit card via{" "}
          <a href="https://cycle.express/" target="_blank" rel="noreferrer">
            cycle.express
          </a>{" "}
          — no exchange account needed. Open this URL with your own principal (from above) in
          place of <code>&lt;principal&gt;</code>:
          <CodeBlock code="https://cycle.express/?to=<principal>" />
        </li>
      </ol>
    </>
  );
}

function ProjectSetupStep() {
  return (
    <>
      <p>Create a fresh directory for your game — this is where all its code will live.</p>
      <CodeBlock code={"mkdir my-game && cd my-game\ngit init"} />
      <p className="hint">
        Optional: for a remote backup (or so an AI assistant can push progress), create an empty
        repository on your git host's website (e.g. GitHub), then link it as `origin` and push:
      </p>
      <CodeBlock code={"git remote add origin <your-repo-url>\ngit push -u origin main"} />
    </>
  );
}

function SkeletonStep() {
  return (
    <>
      <p>
        A full game is six pieces of code — a rules module, a host actor, tests, a frontend
        plugin, and deploy config. You don't have to write any of it by hand.
      </p>
      <p>The whole workflow — copy-and-fill templates for every file, step by step — is written down here:</p>
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
        Working with an AI coding assistant (e.g. Claude Code)? Install that same playbook as a
        skill in your new project directory instead of reading it yourself:
      </p>
      <CodeBlock code="npx skills add research-ag/duel-core --skill duel-game-core" />
      <p className="hint">
        Then just ask it something like: "Build me a duel-game-core game where players ...". The
        skill walks the assistant through the whole rules/host/tests/plugin/config workflow from
        your rules description alone.
      </p>
    </>
  );
}

function DeployStep() {
  return (
    <>
      <p>Once your skeleton is filled in, build and test locally first:</p>
      <CodeBlock
        code={"mops install\nmops test\n\ncd frontend && npm install --legacy-peer-deps && npm run build && cd .."}
      />
      <p>Then deploy to the Internet Computer mainnet — this is the step that spends cycles:</p>
      <CodeBlock code="icp deploy -e ic -y" />
      <p>
        Note <strong>both canister ids</strong> it prints — the registration form in the next step
        needs the backend AND frontend canister id. The frontend canister id is also what you'll
        share with players as the game's URL.
      </p>
    </>
  );
}

function RegisterStep({ isLoggedIn }: { isLoggedIn: boolean }) {
  return (
    <>
      <p>
        Last step — list your game on this dashboard so players can find it. You'll need the
        backend and frontend canister ids from the previous step, a title, a short description,
        and a banner image.
      </p>
      {isLoggedIn ? (
        <p>Click "Register your game" below to open the registration form.</p>
      ) : (
        <p className="error">
          Log in with Internet Identity first (top right), then come back here to register.
        </p>
      )}
    </>
  );
}
