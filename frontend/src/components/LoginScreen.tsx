import { FormEvent, useState } from 'react';
import { Loader2, LockKeyhole, SmilePlus } from 'lucide-react';
import { api } from '../api';
import type { AuthUser } from '../types';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';

interface LoginScreenProps {
  onLoggedIn: (user: AuthUser) => void;
}

export default function LoginScreen({ onLoggedIn }: LoginScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const session = await api.login(username, password);
      onLoggedIn(session.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Nie udalo sie zalogowac');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6 font-sans">
      <Card className="w-full max-w-sm">
        <CardContent className="p-6">
          <div className="mb-6 flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
              <SmilePlus size={24} strokeWidth={2.5} />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">BOT ROMAN</h1>
              <p className="text-sm text-muted-foreground">Logowanie do aplikacji</p>
            </div>
          </div>

          <form className="flex flex-col gap-3" onSubmit={submit}>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Login
              <Input
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Haslo
              <Input
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {error && <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={isSubmitting || !username.trim() || !password}>
              {isSubmitting ? <Loader2 size={16} className="mr-2 animate-spin" /> : <LockKeyhole size={16} className="mr-2" />}
              Zaloguj
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

