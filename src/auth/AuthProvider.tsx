import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { AuthContext } from './auth-context';
import type { AuthContextValue } from './auth-context';

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [membership, setMembership] = useState<{ userId: string | null; isOwner: boolean; error: string | null }>({
    userId: null,
    isOwner: false,
    error: null,
  });
  const [membershipAttempt, setMembershipAttempt] = useState(0);

  useEffect(() => {
    let mounted = true;

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted) return;

      if (error) {
        console.error('No se pudo restaurar la sesión.', error.message);
      }

      setSession(data.session ?? null);
      setSessionLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      setSessionLoading(false);
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const userId = session?.user.id;
    if (!userId) return () => { active = false; };

    void supabase
      .from('app_members')
      .select('user_id')
      .eq('user_id', userId)
      .eq('role', 'owner')
      .maybeSingle()
      .then(async ({ data, error }) => {
        if (!active) return;
        if (error) {
          console.error('No se pudo verificar la membresía del propietario.', error.message);
          setMembership({
            userId,
            isOwner: false,
            error: 'No se pudo verificar el acceso privado. La sesión sigue intacta.',
          });
          return;
        }
        const owner = data?.user_id === userId;
        setMembership({ userId, isOwner: owner, error: null });
        if (!owner) {
          const { error: signOutError } = await supabase.auth.signOut();
          if (signOutError) console.error('No se pudo cerrar una sesión sin membresía.', signOutError.message);
        }
      });

    return () => { active = false; };
  }, [membershipAttempt, session?.user.id]);

  const retryMembership = useCallback(() => {
    setMembership({ userId: null, isOwner: false, error: null });
    setMembershipAttempt((attempt) => attempt + 1);
  }, []);

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }, []);

  const userId = session?.user.id ?? null;
  const membershipMatches = membership.userId === userId;
  const isOwner = Boolean(userId && membershipMatches && membership.isOwner);
  const membershipLoading = Boolean(userId && !membershipMatches);
  const loading = sessionLoading || membershipLoading;

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      isOwner,
      loading,
      membershipError: membership.userId === userId ? membership.error : null,
      retryMembership,
      signOut,
    }),
    [isOwner, loading, membership.error, membership.userId, retryMembership, session, signOut, userId],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
