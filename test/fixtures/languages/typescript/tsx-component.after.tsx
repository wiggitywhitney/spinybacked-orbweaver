// ABOUTME: TSX component fixture for golden file tests.
// ABOUTME: Demonstrates JSX syntax with TypeScript types and an async event handler.

import { trace, SpanStatusCode } from "@opentelemetry/api";

// Minimal JSX type stubs for tsc (--jsx preserve mode, no @types/react needed).
declare global {
  namespace JSX {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Element {}
    // Allow any HTML element with any props to keep the fixture self-contained.
    interface IntrinsicElements {
      [tag: string]: Record<string, unknown>;
    }
  }
}

// Minimal useState stub — type-level only; not executed in golden tests.
declare function useState<T>(init: T): [T, (v: T) => void];

interface UserProfileProps {
  userId: string;
  onSave: (name: string, email: string) => Promise<void>;
}

interface FormSubmitEvent {
  preventDefault(): void;
}

interface InputChangeEvent {
  target: { value: string };
}

const tracer = trace.getTracer("user-profile");

export function UserProfile({ userId, onSave }: UserProfileProps): JSX.Element {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormSubmitEvent): Promise<void> => {
    return tracer.startActiveSpan("UserProfile.handleSubmit", async (span) => {
      try {
        event.preventDefault();
        setError(null);
        span.setAttribute("user.id", userId);
        await onSave(name, email);
      } catch (err: unknown) {
        if (err instanceof Error) {
          span.recordException(err);
        }
        span.setStatus({ code: SpanStatusCode.ERROR });
        setError(err instanceof Error ? err.message : "Save failed");
      } finally {
        span.end();
      }
    });
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        value={name}
        onChange={(e: InputChangeEvent) => setName(e.target.value)}
        placeholder="Name"
      />
      <input
        value={email}
        onChange={(e: InputChangeEvent) => setEmail(e.target.value)}
        placeholder="Email"
      />
      {error && <p>{error}</p>}
      <button type="submit">Save</button>
    </form>
  );
}
