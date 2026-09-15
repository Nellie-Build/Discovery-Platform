/**
 * Passport configuration — the one place this app hands a password to a library instead of
 * checking it itself. `passport-local` verifies the email+password pair against the stored
 * bcrypt hash (see routes.ts for hashing); passport itself only tracks *which* user id the
 * current session belongs to (`serializeUser`/`deserializeUser`) — it never sees a raw password
 * again after the initial check.
 *
 * Builds a fresh `Passport` instance (`new Passport()`) rather than using the package's global
 * singleton (`import passport from 'passport'`): passport's default export keeps its
 * strategies/(de)serializers as shared, ever-growing module state, so calling `createApp()`
 * more than once in the same process (every test in this suite does) would otherwise register a
 * new deserializer on top of every previous one, each still closing over a previous test's
 * (by-then-closed) database handle — the deserializer for a still-open one might never even run.
 */
import passportSingleton from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';

export type PassportInstance = InstanceType<typeof passportSingleton.Authenticator>;
import bcrypt from 'bcryptjs';
import { UsersRepository, toPublicUser, type TransactionCapable, type PublicUser } from '@discovery-platform/db';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends PublicUser {}
  }
}

export function configurePassport(pool: TransactionCapable): PassportInstance {
  const passport = new passportSingleton.Authenticator();
  const users = new UsersRepository(pool);

  passport.use(new LocalStrategy({ usernameField: 'email', passwordField: 'password' }, (email, password, done) => {
    (async () => {
      const user = await users.getUserByEmail(email);
      if (!user) return done(null, false, { message: 'Invalid email or password.' });
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return done(null, false, { message: 'Invalid email or password.' });
      done(null, toPublicUser(user));
    })().catch(done);
  }));

  // Only the user id is ever stored in the session itself — never the password hash, never the
  // full user object (session storage is a database row every request re-reads).
  passport.serializeUser((user: Express.User, done) => {
    done(null, (user as PublicUser).id);
  });

  passport.deserializeUser((id: string, done) => {
    users.getUserById(id).then(user => {
      done(null, user ? toPublicUser(user) : false);
    }).catch(done);
  });

  return passport;
}
