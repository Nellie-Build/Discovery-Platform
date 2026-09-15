import { useState, type FormEvent } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { ApiError } from '@discovery-platform/client';
import { useAuth } from '../lib/auth-context';
import { Button } from '../components/ui/button';
import { Input, Label, FieldError } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';

export function RegisterPage() {
  const { user, register } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await register(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create your account.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Create your account</CardTitle>
          <CardDescription>We'll set up your first workspace automatically.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" required minLength={8} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} />
              <p className="mt-1 text-xs text-slate-400">At least 8 characters.</p>
            </div>
            <FieldError>{error}</FieldError>
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? 'Creating account…' : 'Create account'}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-slate-500">
            Already have an account? <Link to="/login" className="font-medium text-brand-700 hover:underline">Log in</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
