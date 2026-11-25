// ─────────────────────────────────────────────────────────────
// OWNER-ORDERED BLOCKLIST (Tom, 2026-11-23; association expansion
// added the same day on Tom's ruling: "Any wallet those tokens
// move to automatically gets blacklisted too — any wallets those
// wallets are associated with are blacklisted too.").
//
// The first 12 wallets farmed the old FRG staking v1 reward bug
// (Apr 2025 – Jan 2026 window; full forensic report:
// frg-old-app-rewards.md). The rest received farmed FRG from them
// on-chain (hop 1 = direct recipients of a farmer wallet; hop 2 =
// recipients of a hop-1 wallet), traced over each wallet's FULL
// FCD history — see blocklist-association-notes.md. Contract
// recipients (DEX pairs/routers, staking contracts, the P2P
// market) are NOT listed: they cannot register for this program.
// The hop-2 "dust" tier received only 1–80 FRG each, all from one
// hop-1 wallet (terra1d38mgeq…); they are listed per the owner's
// blanket ruling and are the first candidates to strike if the
// owner narrows it.
//
// LUNC association expansion (later the same day, 2026-11-23): a
// second trace pulled every native LUNC send out of the 49 wallets
// above over their FULL FCD histories (80,652 txs) — see
// blocklist-lunc-trace-notes.md. 78 more wallets that received
// native LUNC from a listed wallet are in the LUNC section below,
// so this list now holds 127 wallets in total. Three wallets the
// trace also caught are EXCLUDED by owner ruling and deliberately
// NOT listed: the owner's personal wallet (terra1kur3cr4…gjfcqc),
// the owner's app wallet (terra1hjr335t…a4svu7), and Nicolas
// Boulay's wallet (terra1exl6tue…dyfqur) — Nicolas excluded
// "for now" and may be revisited by the owner.
//
// REACTIVATED by owner ruling (Tom, 2026-11-24): one LUNC-section
// wallet - terra1jnr939dqzdf2xdqk2pgd06mceh2rgmruf7w2n8 (97.48 LUNC
// from 1 listed wallet) - is REMOVED from this list on the owner's
// direct order, leaving 126 listed wallets. Treat it as EXCLUDED,
// exactly like the three wallets above, in any future trace
// rebuild: do not re-add it. See blocklist-association-notes.md.
//
// Listed wallets are barred from this program:
//   - registration is refused (POST /api/register, /api/collect
//     and /api/nft/collect also refuse), and
//   - every payout build EXCLUDES them, even if a registration
//     already exists on file — they never accrue and never get
//     paid while listed here.
// Registrations already on file are NOT deleted; they stay in
// storage untouched and simply take no part in any run. Removing
// an address from this list restores normal treatment.
// ─────────────────────────────────────────────────────────────
export const BLOCKED_WALLETS = new Set([
  // ── The 12 bug farmers (seeds) ──
  'terra1ujw30kn9l6np7qw9flws6u36ympl6mpdf2fce5', // Piter
  'terra1zdnanxgsyy8zqpmy3dfgges4xlzdskqsrx6nm3',
  'terra10juwukwg2fsvvw8zxx4v09lzvf0zx4wkf3czuq',
  'terra13pl88qlk5vdsxqu9dj6aydnyhncayvdvmvmn9p',
  'terra1a9see2df2w8wh8hsty0y6gw9tkamlkzah8kd74',
  'terra1mmkq4pv75yc867ug4ax04jwkw36g3eky2t7uey',
  'terra1eev9sy56det940d2hm7376a4awr6kxgdttr5fa',
  'terra1n5qj93jw56wsym0yp2kpll2ydlpa5c8a0dvej6',
  'terra1p6wzx7f7sdzsqks6rrnek0kgyrfvztgf5af4nc',
  'terra13ml0gd63mhzepfj0qtavl8a6vafvhfp2js06cx',
  'terra1qw9rfq8ukdl0frccp7lfkz4tynm4dweaukg6dq',
  'terra14qu0p7z4vgq69sz30wqx6qjjrpxlnk3nej3yaf',
  // ── Hop 1 — received farmed FRG directly from a farmer ──
  'terra1xnlcfgrwhyt7hjtexa994th9v4zwhqlpe7faqy', // 642,033.83 FRG from Piter (pass-through)
  'terra1wz83ps8ky5tnt0jn5sf348kvxm42j8uwnn3h74', // 175,720.88 FRG from Piter
  'terra1gzutcjsfp522slm998wv0vflcd9pnuxjh5aerg', // 91,041.60 FRG from Piter
  'terra1p9wlsl57700nddpphvj36tdmw94d8k9p7s86mj', // 31,206.81 FRG from 8 different farmers — REGISTERED in Hold & Earn, already paid 931.70 FRG
  'terra1d38mgeqfxheyk86m6krega8w9j3uy3ejq4hckd', // 20,200.00 FRG from terra1zdnanx…
  'terra1euvsvq628sp3e8xkxa934tvjpdk3hk4mpapnnl', // 16,000.00 FRG from terra1zdnanx…
  'terra1v6gvpcut93u9lnv3tsfwv4m820z0jqxwa39lu3', // 2,201.00 FRG from terra10juwuk…
  'terra15f97tusd7xj6k75zz2hprtqugj5x82dqtu4ker', // 475.00 FRG from terra1zdnanx…
  'terra1sj27zm2qtcwyyk88pxecqap77mg77sh2udylcl', // 250.00 FRG from terra1zdnanx…
  // ── Hop 2 — received FRG from a hop-1 wallet (material amounts) ──
  'terra17c2k2gv2p0h8gswgsg6wqynve2c069wmwc5eds', // 179,355.00 FRG from terra1xnlcf…
  'terra1w50lkz9s2w9n90gupna5tsmafj9ccnk3qqhmjy', // 179,355.00 FRG from terra1wz83ps…
  'terra1znz2unxdzewuakd4s2nxxumtgp532lcsxcc9wp', // 16,196.81 FRG from terra1p9wlsl…
  // ── Hop 2 dust tier — 1–80 FRG each, all from terra1d38mgeq… ──
  'terra1d863z7x49ajyg7pyh2dmqdx94a4s7xk6hv8d56', // 80.45 FRG; holds 1,245 FRG
  'terra1u4unrm7aaswpdyhlzd2v0s2379t9zw8ur475gr', // 47.00 FRG
  'terra1dvk2lamwpnf5kxaajjsks3z25vjm0gx9sl8t9y', // 34.00 FRG
  'terra1l7x8rhfwfghspwq0fu5xwv0p00rmdq2s7wzlhr', // 32.00 FRG
  'terra1gatw3h7tndzs3mawmph90argcy84wm7tuzskj2', // 25.00 FRG
  'terra1vce0g3gq7f5nhjdgnyg8jqpaususcawpe3lunv', // 20.00 FRG; holds 1,406.10 FRG
  'terra14cn2dlc7d3698yfc5fr7eraqtzump59sg2ee89', // 20.00 FRG
  'terra1pkd8vk3kuwz6pkmtsadgthp02ur945y97j7533', // 17.00 FRG
  'terra1u7gty2w40nwvwkkkav4p5lfxexhpqlvuf7vacz', // 16.00 FRG
  'terra1x3mrx3735c20m8379y98yqmc40xxyvye30hd4m', // 15.00 FRG
  'terra1ympfumpgzssj5wx5qhls3rgyzw58qy6hw7sqyn', // 15.00 FRG
  'terra1w0pxcs92eg38k8ls9vlayuzg6mw63pcg0rcr2u', // 12.00 FRG
  'terra1e9k7zae9fmus9acv4etuy6fwdl73mm7xalae6n', // 10.00 FRG
  'terra1n6ugpwpkq9yqc2qt65afqyly0t2wu3g8t53d3x', // 10.00 FRG
  'terra13230xlq7an55qf825f6h0hlddyrzhfmh738xef', // 6.00 FRG
  'terra12k9hehu0lltzzuap5tdq930q03ggadrwj5k74y', // 6.00 FRG
  'terra1sa882saeg34dwtp5r8svlnr6ycnf77vqgp8jlh', // 5.00 FRG
  'terra1qetq90gmpu3ryy7n782qyuay0wzaqpfu38p9e7', // 5.00 FRG
  'terra1k3y8qp58gapufhenvv8z28l456n7afyueamvhn', // 5.00 FRG
  'terra1kx9ng5w048t2ltpgu2t6pyyqqcf2z6p60px3r3', // 5.00 FRG
  'terra1nrap8t2zzdmeh40gn9ejcwm53e2yzhrumdusfw', // 5.00 FRG
  'terra1waj7trwa8hf6xcz65q6qapcn4en8k0e3c84ekh', // 5.00 FRG
  'terra109at608ezgecs089th4aftjrwkyg3gkkpc2df0', // 4.00 FRG
  'terra1d0vvmfkfdvz4nmd7z9wpan6m00kjyx6ju56lmj', // 2.00 FRG
  'terra1geqpmxap4wf3gte4ecf5yzz80ums6jnl5l0klj', // 1.00 FRG
  // ── LUNC association — received native LUNC from a listed wallet (traced over full FCD histories 2026-11-23; see blocklist-lunc-trace-notes.md) ──
  'terra1mn3unuuhxt9602v0zwnjum9nmchx4wu846uxsk', // 726,426,949.90 LUNC from 5 listed wallets
  'terra1frh79vmtur5fmrghz6gfjvfhpa3u2c0uemv4af', // 431,371,846.57 LUNC from 5 listed wallets
  'terra1w8nc8ev0ylg97qnj080np4lnljngdvpd90ev63', // 189,062,881.36 LUNC from 4 listed wallets
  'terra1pegjt8gmpxu75p3f20cxc8f8hr987fe7vwptq4', // 48,299,614.00 LUNC from 2 listed wallets
  'terra144sq090mfcsm60nrv0gl4uuzw0wx2qm2jx9yj6', // 47,220,334.00 LUNC from 2 listed wallets
  'terra1akmejrr9wmv5fg02c28jfl7m594xszx9fnah88', // 6,100,000.00 LUNC from 1 listed wallet
  'terra1m8zkrucn6h4cswwtjxw28q3gzkpaq58dj54yay', // 5,448,000.00 LUNC from 2 listed wallets
  'terra1xzs3zuwv9qe9j6v0rm0p3g8ak6wrpef5e6yxun', // 3,380,000.00 LUNC from 2 listed wallets
  'terra1l2gku8hg99sftkwzylzh30fkctjjvszdstjsc8', // 2,824,000.00 LUNC from 1 listed wallet
  'terra1cm9v57jr0pz2vf9fe0e8hhk7ws3wg354mkervf', // 2,503,000.00 LUNC from 2 listed wallets
  'terra1vtdg0g273kz9z5tv0zhtqrk3afjps85q2a0x85', // 2,480,003.00 LUNC from 1 listed wallet
  'terra1jx6p6t50h5hlypwnmr8r0sf3v9pr6tsyuhv2e0', // 2,480,000.00 LUNC from 1 listed wallet
  'terra1vswkwyqt53jl56tn7ac3529drcsqgn4qpksvet', // 1,000,000.00 LUNC from 1 listed wallet
  'terra1z2r0w4yu2g4g59e64fu55shn8re3jn9p523pjp', // 1,000,000.00 LUNC from 1 listed wallet
  'terra1vkf06kqtpg0m9sn2cvmjksz3ew35nrlshyvjf0', // 900,000.00 LUNC from 1 listed wallet
  'terra1ych4qknjczfwmfljgwqw2eaf85y8jcu9yh27hr', // 500,000.00 LUNC from 1 listed wallet
  'terra15mmdm4tuzp30w9cvjkwv56676glw7393uuw88x', // 358,852.00 LUNC from 1 listed wallet
  'terra1pqc60ykjue65slh64muvdfeqqcy62xmnvmzkt6', // 292,000.00 LUNC from 2 listed wallets
  'terra1qz60r8u6huvr04ngxm6plgzennwpwut35fdak8', // 250,000.00 LUNC from 1 listed wallet
  'terra1cfxhcfx30j3snuuzltutugn00vke2252uyzkls', // 175,000.00 LUNC from 2 listed wallets
  'terra1r2w86sltj9vx8curzhlytsnfqa9wpfxn6xr8ud', // 81,000.00 LUNC from 2 listed wallets
  'terra1umsjstkgq2nhu3dhwg33qxz5wpntu34ys3fj5g', // 70,000.00 LUNC from 1 listed wallet
  'terra1lkcsxf2et3s64uwemyy257n0dcep0al40a4m55', // 42,887.88 LUNC from 5 listed wallets
  'terra1j8fhdgk8lwuakgjax30nxh5lddrq07w77gjsux', // 40,500.00 LUNC from 1 listed wallet
  'terra16kwctv9ye5ztfa0wcpfh20q53gn5w7cjw4qy7y', // 35,000.00 LUNC from 1 listed wallet
  'terra17g03g2vdcw88ac499ejpy5p4uaeyqw39ue2jew', // 34,494.00 LUNC from 1 listed wallet
  'terra1raurqm408j0lsg6luge5a3hsvpkvqxjxrapmpx', // 25,000.00 LUNC from 1 listed wallet
  'terra1kke2550krgmllk6tuhal70qkk47a77jpztqsj6', // 20,000.00 LUNC from 1 listed wallet
  'terra1mx7t8a82tpt869e5l7sa0aaua7utf4r3h0fhey', // 20,000.00 LUNC from 1 listed wallet
  'terra1amxdfw6e58e929rdswmfj73hdls984lnta8f7g', // 20,000.00 LUNC from 2 listed wallets
  'terra18m8lgy35nqypx7jnv5n8x9lwh5necyym5upndl', // 20,000.00 LUNC from 1 listed wallet
  'terra1pwmnn2jwa9re928ugyck0x354y9vuea94gmml6', // 11,015.00 LUNC from 2 listed wallets
  'terra12lm5x86eesqajuw2vc86rtc8pa8rhca5qayclt', // 10,040.00 LUNC from 1 listed wallet
  'terra196xse3afn29g50fgevfucxfj7hxxe77v686ksp', // 9,900.00 LUNC from 1 listed wallet
  'terra1sfa3jy4pkddugv9uvu9thg7w6f2fj5pqxjfxse', // 5,862.00 LUNC from 1 listed wallet
  'terra1549z8zd9hkggzlwf0rcuszhc9rs9fxqfy2kagt', // 5,000.00 LUNC from 1 listed wallet
  'terra1rjjx27gltwhnztawvf5j2ugrvlvywd4lathzd2', // 5,000.00 LUNC from 1 listed wallet
  'terra1st8p5p3djf9t0px983my0w6puuspyf6h0a5jvc', // 4,000.00 LUNC from 1 listed wallet
  'terra1e5znewyae5r37ltnr9e4vyxcw6uztttl6wy5x9', // 2,000.00 LUNC from 1 listed wallet
  'terra1k0me2vhajhqqvd5c8w5rajcmd3mz0t2xmjeeht', // 1,020.00 LUNC from 1 listed wallet
  'terra15ypz0dste5ltpe663948prl5wg0pu9fekhzu3k', // 1,000.00 LUNC from 1 listed wallet
  'terra1cqwjtzaf48ky6t7qjw8mljfc05sktn4rtxuf7y', // 1,000.00 LUNC from 1 listed wallet
  'terra1vj2tresfzjpxf3njtnmlcgww36m7mtfrcen84m', // 1,000.00 LUNC from 1 listed wallet
  'terra1059jezdej0llgnymqsy8y2s9etucgqy9le7gqx', // 918.33 LUNC from 1 listed wallet
  'terra16k70dgtf0wc6ak85j5trhwu20jsyqgvt9c60z3', // 878.68 LUNC from 1 listed wallet
  'terra1k6x0lhm9hgrzxzanqmxw9kftvzj0knv8383tdy', // 500.00 LUNC from 1 listed wallet
  'terra1pf5wc9tvskafjdzleln95g6jq4pemsnev84ta2', // 500.00 LUNC from 1 listed wallet
  'terra1wzxz5652yp8anarrgch2hzqpwvzawrq7ycx63r', // 500.00 LUNC from 1 listed wallet
  'terra1yrcx2jajy97lyp7p8n8wgwp4cdngczv3vy6q4v', // 500.00 LUNC from 1 listed wallet
  'terra1tz26uuxm8ddevxmda3r3ea3g24luced4lge6jx', // 400.00 LUNC from 1 listed wallet
  'terra19rlltp5j8nsp9gz777utu5nx0f9986kfu5f6l7', // 379.52 LUNC from 1 listed wallet
  'terra1hqs3eqpv960sv80s3f9jhxu39ankcdc76222uq', // 300.00 LUNC from 1 listed wallet
  'terra1qc6czrcpl7yaty80ncvzhf967vf0rqwqrktn9k', // 200.00 LUNC from 1 listed wallet
  'terra1nxc2mfd4x3mvpaxsqh3qg79j5aktaaq5tc24lr', // 200.00 LUNC from 1 listed wallet
  'terra18hzngkhp6v6exrf29rsz0vfpx8hjstp7can9t5', // 160.00 LUNC from 1 listed wallet
  'terra1kvt9xnq0zpthvsjws2f453cskqejg7a7tcu0em', // 151.00 LUNC from 1 listed wallet
  'terra12v5pxjv76hydvlj46kccqe362cky5rps92kqgg', // 100.00 LUNC from 1 listed wallet
  'terra1287ky9jtvhxp2y474nyl3lz47dvsy5x0guu3gw', // 100.00 LUNC from 1 listed wallet
  'terra1luzv7tfa4lxfze9ucvrdtf2tkxgzxl0adxd62y', // 100.00 LUNC from 1 listed wallet
  'terra1at92kzu3q3j77a7nwndkrm6yx75vaswujx635r', // 98.24 LUNC from 1 listed wallet
  'terra190z6d2g8phmnjnwmd6qn672zzv8anfcj730kh0', // 70.00 LUNC from 2 listed wallets
  'terra1exepq8cw3ymna9pcr0wkhgr2etklq86xtf5smf', // 60.00 LUNC from 2 listed wallets
  'terra173q2j4pj2h74vcejq56k286uyy6xz8943zjxmt', // 60.00 LUNC from 2 listed wallets
  'terra1m4lsequc083nvj3w0y7y3et49j9vec4gxzehrd', // 40.00 LUNC from 1 listed wallet
  'terra1736essvw7tyk5jsgkz9mg8k7z57r2um5n9586g', // 30.00 LUNC from 2 listed wallets
  'terra1p74r8a9y5d9rn57x3xraq4lrlg8m6erd8gup6f', // 30.00 LUNC from 1 listed wallet
  'terra1hue9248w78u0fh0zh0xdp7kvzktmcwre7y6pef', // 20.00 LUNC from 1 listed wallet
  'terra1ldjlajn76kszgzg3p5fehftps9y369gccdq2tz', // 20.00 LUNC from 1 listed wallet
  'terra1j0f6uqvjat0r2e0lgu6ml9kkcmqlqtmnn6gzus', // 20.00 LUNC from 1 listed wallet
  'terra1skhucrm7uqpevsjjsw9zg094npf65x8mek5v6p', // 20.00 LUNC from 1 listed wallet
  'terra1z7454fjr6rkyn0rf6v7ngyqqmqtmpcgpcpm75x', // 20.00 LUNC from 1 listed wallet
  'terra17x7va6j5ylschlfvvr60vzw6e29vsp26ptqg3a', // 20.00 LUNC from 1 listed wallet
  'terra1n3gfyqvzp5pwt702n0402veay5lp02dy9kdam2', // 20.00 LUNC from 1 listed wallet
  'terra1adhhflk73sewggrvuwrev90fkq5r3junkd3ad4', // 20.00 LUNC from 1 listed wallet
  'terra129n0yqra8j54gnjeackarknh4aus4u9c4smswq', // 10.00 LUNC from 1 listed wallet
  'terra15wdzlt3rhepw0m3fyrymx4drshw8xvs7dyc43n', // 1.00 LUNC from 1 listed wallet
  'terra1rxzg3wqasuvszc8gh02pnseu59krrsqcxp32xx', // 0.20 LUNC from 1 listed wallet
]);

export function isBlocked(address) {
  return BLOCKED_WALLETS.has(address);
}
