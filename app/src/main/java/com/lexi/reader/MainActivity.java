package com.lexi.reader;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * 单 Activity + WebView 容器。
 *
 * 与 web 层的契约：
 *   window.Android.toast(msg)              原生 Toast
 *   window.Android.share(text)             系统分享
 *   window.Android.openUrl(url)            外部浏览器
 *   window.Android.setCanBack(bool)        返回键是否交给页面处理
 *   window.Android.setTheme('light'|'dark') 同步状态栏 / 导航栏 / WebView 底色
 *   window.Android.setImmersive(bool)      沉浸模式：隐藏 / 显示状态栏
 *   window.Android.getSystemTheme()        返回系统深浅色 'light' | 'dark'
 *   window.Android.getInsets()             返回 "top,bottom"（CSS px）
 *   window.Android.getVersionName()        真实 versionName
 *   window.Android.getPackageId()          真实包名
 *   window.__lgSystemTheme(mode)           系统深浅色变化时由原生回调
 *   window.__lgInsets(top, bottom)         安全区变化时由原生回调（CSS px）
 *
 * 布局策略：WebView 始终 edge-to-edge（setPadding 恒为 0），
 * 所有安全区间距由 web 层用 --safe-top / --safe-bottom 处理 ——
 * 这样状态栏区域也能被页面的极光背景和玻璃覆盖，不会出现一条纯色白边。
 */
public class MainActivity extends Activity {

    private static final String HOST = "law.local";
    private static final String BASE = "https://" + HOST + "/";
    private static final int COLOR_DARK = 0xFF08080A;
    private static final int COLOR_LIGHT = 0xFFF2F3F7;

    private WebView web;
    private volatile boolean canBack = false;
    private boolean immersive = true;
    private int[] lastInsets = new int[] { 0, 0 };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        if (Build.VERSION.SDK_INT >= 26) {
            s.setSafeBrowsingEnabled(false);
        }

        web.setBackgroundColor(isSystemDark() ? COLOR_DARK : COLOR_LIGHT);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebViewClient(new LocalClient());
        if (Build.VERSION.SDK_INT >= 19) {
            WebView.setWebContentsDebuggingEnabled(false);
        }

        setContentView(web);

        // targetSdk < 35 在 Android 15/16 上被系统「退出 edge-to-edge」处理：
        // 光加 NO_LIMITS 只把窗口铺开，DecorView 仍会给 content 加 inset 内边距，
        // 结果是窗口铺满了、WebView 却被压到状态栏下面，顶部留一条黑边。
        // 关掉这两层的 fitsSystemWindows，inset 只走我们自己的 listener。
        View contentFrame = findViewById(android.R.id.content);
        if (contentFrame != null) contentFrame.setFitsSystemWindows(false);
        getWindow().getDecorView().setFitsSystemWindows(false);

        // edge-to-edge：内容铺满整屏（含状态栏 / 手势条区域）。
        // 前提是 targetSdk >= 35（build.sh 会把 manifest 里的 34 改成 35）——
        // Android 15/16 只对 targetSdk >= 35 的应用强制 edge-to-edge，
        // 低 targetSdk 的包窗口会被系统栏内缩，顶部永远留一条不属于 App 的边。
        getWindow().setBackgroundDrawable(
                new android.graphics.drawable.ColorDrawable(isSystemDark() ? COLOR_DARK : COLOR_LIGHT));
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        }
        web.setPadding(0, 0, 0, 0);

        web.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                pushInsets(insets);
                return insets;
            }
        });

        applyBars(isSystemDark());
        applyImmersive(true);
        web.requestApplyInsets();

        web.loadUrl(BASE + "index.html");
    }

    /* ------------------------------------------------------------ 安全区 */
    /** 把真实 inset 换算成 CSS px 推给 web 层，并自己缓存一份供 getInsets() 查询 */
    private void pushInsets(WindowInsets insets) {
        int topPx;
        int bottomPx;
        if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.statusBars());
            android.graphics.Insets cut = insets.getInsets(WindowInsets.Type.displayCutout());
            android.graphics.Insets nav = insets.getInsets(WindowInsets.Type.navigationBars());
            // 状态栏隐藏后系统仍会报 statusBars inset（视觉上已经没有那条了），
            // 沉浸态只保留挖孔的安全距离，否则标题上方会白留一大块
            topPx = immersive ? cut.top : Math.max(bars.top, cut.top);
            bottomPx = nav.bottom;
        } else {
            topPx = Math.max(insets.getSystemWindowInsetTop(), 0);
            bottomPx = Math.max(insets.getSystemWindowInsetBottom(), 0);
        }
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0f) density = 1f;
        int top = Math.round(topPx / density);
        int bottom = Math.round(bottomPx / density);
        lastInsets[0] = top;
        lastInsets[1] = bottom;
        if (web != null) {
            web.evaluateJavascript("window.__lgInsets&&window.__lgInsets(" + top + "," + bottom + ")", null);
        }
    }

    /* ------------------------------------------------------------ 沉浸模式 */
    /**
     * @param on true = 隐藏状态栏（沉浸），false = 显示状态栏。
     * 导航栏一直保留 —— 手势返回条隐藏后会明显影响操作手感。
     */
    private void applyImmersive(boolean on) {
        immersive = on;
        Window w = getWindow();
        View decor = w.getDecorView();
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                if (on) {
                    c.hide(WindowInsets.Type.statusBars());
                } else {
                    c.show(WindowInsets.Type.statusBars());
                }
            }
        } else {
            decor.setSystemUiVisibility(systemUiFlags(isSystemDark()));
        }
        if (web != null) {
            web.requestApplyInsets();
        }
    }

    /** API < 30 的全局 flags（沉浸 + 浅色图标共用一次 setSystemUiVisibility） */
    private int systemUiFlags(boolean dark) {
        int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
        if (immersive) {
            flags |= View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
        }
        if (!dark) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= 26) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
        }
        return flags;
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // 下拉通知栏 / 切后台回来后系统会把状态栏放出来，需要重新压回去
        if (hasFocus) applyImmersive(immersive);
    }

    /* ------------------------------------------------------------ 系统深浅色 */
    private boolean isSystemDark() {
        int mode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES;
    }

    private void applyBars(boolean dark) {
        int bg = dark ? COLOR_DARK : COLOR_LIGHT;
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 21) {
            w.setStatusBarColor(Color.TRANSPARENT);
            w.setNavigationBarColor(Color.TRANSPARENT);
        }

        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(dark ? 0 : mask, mask);
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                if (immersive) c.hide(WindowInsets.Type.statusBars());
            }
        } else {
            w.getDecorView().setSystemUiVisibility(systemUiFlags(dark));
        }
        if (web != null) {
            web.setBackgroundColor(bg);
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        final boolean dark = isSystemDark();
        if (web != null) {
            web.post(new Runnable() {
                @Override
                public void run() {
                    applyBars(dark);
                    applyImmersive(immersive);
                    web.requestApplyInsets();
                }
            });
        }
        // 只在页面处于「跟随系统」时由 JS 决定是否切换，原生只负责把系统状态推过去
        if (web != null) {
            web.post(new Runnable() {
                @Override
                public void run() {
                    web.evaluateJavascript(
                            "window.__lgSystemTheme&&window.__lgSystemTheme('" + (dark ? "dark" : "light") + "')",
                            null);
                }
            });
        }
    }

    /* ------------------------------------------------------------ JS 桥 */
    private class Bridge {

        @JavascriptInterface
        public void toast(final String msg) {
            if (msg == null) return;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void share(final String text) {
            if (text == null) return;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent i = new Intent(Intent.ACTION_SEND);
                    i.setType("text/plain");
                    i.putExtra(Intent.EXTRA_TEXT, text);
                    startActivity(Intent.createChooser(i, "分享"));
                }
            });
        }

        @JavascriptInterface
        public void openUrl(final String url) {
            if (url == null || url.isEmpty()) return;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this, "无法打开链接", Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }

        @JavascriptInterface
        public void setCanBack(boolean v) {
            canBack = v;
        }

        /** web 层切换主题后同步系统栏与 WebView 底色 */
        @JavascriptInterface
        public void setTheme(final String mode) {
            final boolean dark = "dark".equals(mode);
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    applyBars(dark);
                }
            });
        }

        /** 沉浸模式开关：true 隐藏状态栏 */
        @JavascriptInterface
        public void setImmersive(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    applyImmersive(on);
                }
            });
        }

        /** 当前安全区（CSS px）："top,bottom" */
        @JavascriptInterface
        public String getInsets() {
            return lastInsets[0] + "," + lastInsets[1];
        }

        /** 供 web 层查询系统深浅色（'light' / 'dark'） */
        @JavascriptInterface
        public String getSystemTheme() {
            return isSystemDark() ? "dark" : "light";
        }

        /** 供 web 层显示真实 versionName（改包名/改版本后不必再改前端） */
        @JavascriptInterface
        public String getVersionName() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

        /** 供 web 层显示真实包名 */
        @JavascriptInterface
        public String getPackageId() {
            return getPackageName();
        }
    }

    /* ------------------------------------------------------------ 资源拦截 */
    private class LocalClient extends WebViewClient {

        private final Map<String, String> mime = new HashMap<String, String>();

        LocalClient() {
            mime.put("html", "text/html");
            mime.put("css", "text/css");
            mime.put("js", "application/javascript");
            mime.put("json", "application/json");
            mime.put("svg", "image/svg+xml");
            mime.put("png", "image/png");
            mime.put("jpg", "image/jpeg");
            mime.put("jpeg", "image/jpeg");
            mime.put("woff2", "font/woff2");
            mime.put("ttf", "font/ttf");
        }

        private String mimeOf(String path) {
            int dot = path.lastIndexOf('.');
            if (dot < 0) return "application/octet-stream";
            String ext = path.substring(dot + 1).toLowerCase();
            String m = mime.get(ext);
            return m == null ? "application/octet-stream" : m;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (uri == null || !HOST.equals(uri.getHost())) return null;

            String path = uri.getPath();
            if (path == null || path.equals("/") || path.isEmpty()) {
                path = "/index.html";
            }
            if (path.startsWith("/")) path = path.substring(1);

            try {
                InputStream in = getAssets().open("web/" + path);
                Map<String, String> headers = new HashMap<String, String>();
                headers.put("Cache-Control", "no-cache");
                headers.put("Access-Control-Allow-Origin", "*");
                WebResourceResponse resp = new WebResourceResponse(mimeOf(path), "utf-8", in);
                resp.setResponseHeaders(headers);
                return resp;
            } catch (IOException e) {
                byte[] body = ("not found: " + path).getBytes();
                return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(body));
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (uri != null && HOST.equals(uri.getHost())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) {
            }
            return true;
        }
    }

    /* ------------------------------------------------------------ 返回键 */
    @Override
    public void onBackPressed() {
        if (canBack && web != null) {
            web.evaluateJavascript("window.appBack&&window.appBack()", new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    if (!"true".equals(value)) moveTaskToBack(true);
                }
            });
            return;
        }
        moveTaskToBack(true);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("Android");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
