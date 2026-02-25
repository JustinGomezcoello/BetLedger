import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://agroiysnoiwllhupiral.supabase.co'
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFncm9peXNub2l3bGxodXBpcmFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwMjkyMzgsImV4cCI6MjA4NzYwNTIzOH0.AAcsoLQo1-mvigfOHHQIv3VKsPJsdMF3iJzyqPpFGS0'

export const supabase = createClient(supabaseUrl, supabaseKey)
