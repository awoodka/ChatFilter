import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE_NAME = "chatfilter_session";

function isProtectedPath(pathname: string): boolean {
  return (
    pathname === "/eval" ||
    pathname.startsWith("/eval/") ||
    pathname === "/live" ||
    pathname.startsWith("/live/") ||
    pathname === "/settings" ||
    pathname.startsWith("/settings/")
  );
}

function isAuthPath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/signup";
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSessionCookie = Boolean(req.cookies.get(SESSION_COOKIE_NAME)?.value);

  if (isProtectedPath(pathname) && !hasSessionCookie) {
    const target = new URL("/login", req.url);
    target.searchParams.set("next", pathname);
    return NextResponse.redirect(target);
  }

  if (isAuthPath(pathname) && hasSessionCookie) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/eval/:path*", "/live/:path*", "/settings/:path*", "/login", "/signup"],
};
