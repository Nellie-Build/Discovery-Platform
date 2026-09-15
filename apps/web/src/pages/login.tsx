import { useState, type FormEvent } from 'react';
import { Navigate, Link, useLocation } from 'react-router-dom';
import { ApiError } from '@discovery-platform/client';
import { useAuth } from '../lib/auth-context';
import { Button } from '../components/ui/button';
import { Input, Label, FieldError } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';

export function LoginPage() {
  const { user, login } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) return <Navigate to={(location.state as { from?: string } | null)?.from ?? '/'} replace />;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not log in.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Discovery Platform</CardTitle>
          <CardDescription>Log in to your workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
            </div>
            <FieldError>{error}</FieldError>
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? 'Logging in…' : 'Log in'}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-slate-500">
            No account yet? <Link to="/register" className="font-medium text-brand-700 hover:underline">Create one</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
