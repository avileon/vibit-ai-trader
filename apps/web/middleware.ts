import { NextResponse, type NextRequest } from 'next/server';

// UX gate only — real authorization is enforced by the API on every request.
export function middleware(req: NextRequest) {
  const has = req.cookies.has('vibit_session');
  const { pathname } = req.nextUrl;
  if (!has && pathname !== '/login') return NextResponse.redirect(new URL('/login', req.url));
  return NextResponse.next();
}
export const config = { matcher: ['/((?!api|_next|favicon.ico).*)'] };
