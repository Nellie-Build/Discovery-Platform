import { useAuth } from '../lib/auth-context';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Button } from '../components/ui/button';

export function AccountPage() {
  const { user, logout } = useAuth();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Account</h1>
        <p className="mt-1 text-sm text-slate-500">Your personal account details.</p>
      </div>

      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>Signed in as</CardTitle>
          <CardDescription>{user?.email}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="secondary" onClick={() => { void logout(); }}>Log out</Button>
        </CardContent>
      </Card>
    </div>
  );
}
