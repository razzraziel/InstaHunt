# Insta Hunt v0.5.2

Instantly simulate grinding with your character against selected normal monster spawns near your current position. Raid bosses and their minions are excluded. There is no automatic shopping or remote hunting area selection.

## Installation

1. Stop your server.
2. Copy the `InstaHunt` folder into your server root, in the main folder containing `src` and the database.
3. Open `InstaHunt/AddOrRemove.vbs` and click **Add** in the pop-up. You do not need to type a command or run as administrator; normal write access to your server files is sufficient.
4. Start your server normally. Type `.h`, `.hunt`, or `.instahunt` in game.

AddOrRemove only uses the parent of the `InstaHunt` folder. It does not search for a server or ask you to browse for a folder. If it cannot find the required server files there, it stops without changing anything.

Setup adds Insta Hunt connections to `src/GameServer/Network/Opcodes.js` and `src/Database.js`. It preserves their current content and saves original copies and verification hashes in `InstaHunt/backups`. Repeating installation does not add duplicate connections. Setup blocks changes while the server or its database is in use.

## Server updates

If a server update replaces Database.js or Opcodes.js, stop the server and click **Add** again. Setup reads the current files and adds the connections again. It does not overwrite updated server files with older copies. Existing Insta Hunt connections are removed before adding a single current connection.

The file contents may change, but their module export names and the database functions used by Insta Hunt must remain compatible. If these interfaces change, setup reports that a compatible Insta Hunt update is required and leaves the files unchanged. Automatic compatibility with every future server version is not guaranteed.

Keep the `backups` folder and `installation.json`. Preserve these records when updating Insta Hunt. The distribution ZIP does not include user backups or installation records.

## Readable setup source

`AddOrRemove.vbs` opens the Windows pop-up without a console window. `AddOrRemove.ps1` contains the two-button interface. `ServerIntegration.js` handles backups and server connections. All files are readable text. There are no compiled executables, unreadable scripts, or downloaded setup components. Upload the extracted InstaHunt folder to GitHub so people can read the files before downloading.

The server redirects Petition requests to Insta Hunt; the client button remains named Petition. Some C4 clients open their own local Petition form and only send a server request when that form is submitted. In that case, use `.instahunt` to open the panel directly. The button's local behavior cannot be guaranteed without modifying the client.

## Usage

Go to the location where you want to grind, stop moving and leave combat, then type `.h`, `.hunt`, or `.instahunt`. Select monster types, duration, shot settings, **Spoil: ON/OFF**, and optionally the use of your existing healing potions. The **Hunt** button below the centered **Roll and Calculate** heading shows the rolled outcome. **Apply** applies rewards and resource consumption. Calculating does not grant rewards or consume resources.

Enter the number of minutes you want to simulate in the **Minutes** field, then click **Hunt** directly or **Set** to keep the value. The **1h**, **2h**, **4h**, **8h**, and **12h** presets select 60, 120, 240, 480, and 720 minutes. There is no daily quota or maximum hunt duration. Your inventory resources and ability to defeat the selected monsters determine how long hunting can continue. Settings are in `config.json`; restart the server after changing them.

Shots are selected for your current weapon grade. The panel has a single **Shots: ON/OFF** option, initially **ON**. Physical attacks use compatible soulshots. Magic attacks use compatible spiritshots, preferring stocked blessed spiritshots and falling back to regular spiritshots when needed. Grade selection follows your equipped weapon. There is no separate magic-shot switch. Hunting stops when arrows run out. When shots run out, **Continue without** is selected by default; you may switch to **Stop** in the panel. Movement, respawn waits, and HP/MP recovery consume simulated time. Level and combat strength update after each victory. Rewards use the server's current XP, SP, adena, and drop rates.

The result panel shows simulated time, kills, XP, SP, adena, drops, consumed items, and the stop reason. A successful **Apply** also writes one short completion message to your chat with simulated time, kills, XP, and adena. **Hunt** does not write completion messages. A monster you cannot defeat or finish within the time limit gives no rewards; earlier victories retain their rewards. A simulated defeat stops the hunt without killing your character in the live world; HP remains at least 1. By default, Insta Hunt follows normal server item-award behavior and does not impose additional inventory restrictions. Set `enforceInventoryLimits` to `true` in `config.json` if you want Insta Hunt to stop before a fight whose rewards would exceed inventory slot or weight capacity. In that mode, the fight's outcome is not applied.

This version is for solo characters. It cannot be used with an active party, pet, summon, shop, or trade. It does not advance quest kill or drop objectives. Spawn access uses the server's geodata and visibility checks; areas without geodata rely on distance and floor-height filters.

Results are stored in `insta_hunt_results` in the existing `nodel2.sqlite` database. Consumption and rewards are committed in one transaction. Repeating the same start request does not grant duplicate rewards.

## Validation limits

Source, isolated SQLite transactions, and simulation behavior were checked. Setup checks covered installation, removal, reinstalling after server file updates, preserving later updates during removal, and rollback after a write failure. The Windows pop-up has not been run in this Linux environment, and the feature has not been tested end to end with a running game client. For the first in-game check, compare XP, SP, resource consumption, simulated duration, and the result panel with a short duration and a few monster types.

## Removal

Stop your server, open `AddOrRemove.vbs`, and click **Remove**. If the server files have not changed since installation, their original backups are restored exactly. If a later server update or another edit changed them, setup preserves those changes and removes only the Insta Hunt connections. The result message tells you when later changes were preserved.

Removal does not delete player data or Insta Hunt result history from the database. You may remove the InstaHunt folder afterward. To temporarily disable the feature, set `enabled` to `false` in `config.json` and restart the server.

## Updating from an earlier Insta Hunt package

Stop the server and replace the feature files in your existing InstaHunt folder. Keep `backups` and `installation.json`. Version 0.5.1 adds `.h`, displays the version in both interfaces, renames the setup files to AddOrRemove, and adjusts the panel layout. Previous updates replaced the daily quota with custom duration controls. The addon supports a custom minutes field and five duration presets, and removes the extra inventory restriction from the default behavior. If you preserve an older config, its previous daily quota and calculation caps are ignored. Missing new options use the current defaults; additional inventory restrictions are disabled unless `enforceInventoryLimits` is explicitly `true`. Delete the old `Setup.bat`, `Setup.ps1`, and `install.js` files after replacing the feature files; use `AddOrRemove.vbs` from now on. Start the server normally; reinstalling the connections is unnecessary unless a server update replaced them.

## Recovery and repeated estimates

A monster readiness check requesting HP/MP recovery now counts recovery time and resumes hunting. It is not reported as an unbeatable monster. Repeated estimates use a stable random seed for the same character state, duration, selected targets, and settings. Changes to equipment, ammunition, inventory, HP/MP, buffs, or selected targets can change the estimate. The buffs active when calculating the hunt stay active throughout the simulation, regardless of their remaining live duration. This includes self buffs, buffs received from others, and active toggle buffs; debuffs are excluded. Their live-world timers are not extended. Recovery applies their regeneration bonuses. Spawn schedules can still affect the result over time. The calculated result is stored until applied or discarded. Applying only filters disabled item types; XP, SP, adena, consumption and the quantities of selected drops remain exactly as calculated. Inventory and duplicate-award checks remain active.

## Selecting drops

After **Hunt**, the **Collect drops** list contains every rolled drop type, six rows per page. Use **Previous / Next** to browse. Drop selection opens on a separate compact page to avoid jumping back through the long result summary. Click a checkbox or item name to toggle collection. **Select all / Clear all** applies to every rolled drop type across all pages. Disabled item types are not added to inventory by **Apply**. XP, SP, and adena are still awarded; adena is not part of the item filter. Filtering does not reroll drops. Apply uses the stored calculation and never rerolls rewards. It awards the exact displayed amounts for selected items. If equipment, inventory, level, skills or location change afterward, the stored result is not applied; calculate a new result. Natural HP/MP regeneration does not reroll the result.

**Spoil** defaults to **OFF**. When **ON**, spoil rewards use the normal server spoil tables and rates regardless of character class or learned skills. A one-second preparation step per attempted fight is included in simulated time. Changing Spoil requires a new calculation, so the list includes the corresponding spoil drops. The option does not teach the live character a Spoil skill.

## Errors and drop probability

Errors appear in the panel and in your chat as an IH error code and a short explanation. Share that code and message when reporting a problem. The server log includes the same code with technical details. If rewards were committed before a display error, the message says that they were already saved so you do not accidentally apply twice.

Hunt performs random drop rolls using the server tables. A 1% chance over 100 kills is an average of one item, not a guaranteed item. Whatever the calculation actually rolls is shown before applying. Apply does not repeat the rolls or change the selected item quantities.

## Version 0.5.2

A stationary character in Walk mode can open Insta Hunt. Only actual movement or combat blocks access; social emotes do not block the panel. Every successful new Hunt calculation selects all rolled drops and resets drop pagination. Apply plays the Victory social animation and a short completion sound after rewards are saved and the character is updated. Previewing, filtering, errors, and duplicate applications do not play completion feedback.
